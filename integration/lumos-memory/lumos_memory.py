"""Core of the Lumos memory MCP server for Nimbus.

Ports the behavior of Hermes ``tools/memory_tool_store.py`` (bounded, '§'-delimited
MEMORY.md / USER.md with a strict content scan) and the holographic memory plugin's
tool handlers, ``on_memory_write`` mirror and auto-extract, against a lumos-home
generation folder. The holographic fact store itself runs from the byte-identical
copies in ``pinned/`` (hashes in ``pinned/PINS.json``).

Home layout (a copy of the Hermes home taken at cutover):
    <home>/memories/MEMORY.md    agent notes   (limit 2200 chars)
    <home>/memories/USER.md      user profile  (limit 1375 chars)
    <home>/memory_store.db       holographic fact store (read/write)
    <home>/state.db              conversation history (read-only, FTS5)
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sqlite3
import sys
import tempfile
import threading
import time
import types
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
PINNED_DIR = HERE / "pinned"
logger = logging.getLogger("lumos_memory")

# ---------------------------------------------------------------------------
# Pinned module loading
# ---------------------------------------------------------------------------


class PinMismatch(RuntimeError):
    pass


def verify_pins(pinned_dir: Path = PINNED_DIR) -> Dict[str, str]:
    """Raise PinMismatch unless every pinned file matches PINS.json. Returns {name: sha256}."""
    pins = json.loads((pinned_dir / "PINS.json").read_text(encoding="utf-8"))
    seen = {}
    for name, rec in pins["files"].items():
        path = pinned_dir / name
        if not path.is_file():
            raise PinMismatch(f"pinned file missing: {path}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != rec["sha256"]:
            raise PinMismatch(f"pinned file {name} sha256 {digest} != PINS.json {rec['sha256']}")
        seen[name] = digest
    return seen


def _install_hermes_shims() -> None:
    """store.py lazily imports two Hermes helpers inside _init_db. Provide equivalents
    so the pinned file runs unmodified outside Hermes."""
    if "hermes_state_wal" not in sys.modules:
        wal = types.ModuleType("hermes_state_wal")

        def apply_wal_with_fallback(conn, *, db_label="state.db", require_wal=False):
            # Never change the journal mode: a WAL-mode copy stays WAL, a new DB stays
            # DELETE. This matches Hermes on the bundled SQLite (WAL-reset-vulnerable
            # builds never enable WAL on a non-WAL file and never downgrade a WAL one).
            return str(conn.execute("PRAGMA journal_mode").fetchone()[0]).lower()

        wal.apply_wal_with_fallback = apply_wal_with_fallback
        sys.modules["hermes_state_wal"] = wal
    if "hermes_cli.sqlite_util" not in sys.modules:
        pkg = sys.modules.get("hermes_cli") or types.ModuleType("hermes_cli")
        pkg.__path__ = getattr(pkg, "__path__", [])
        util = types.ModuleType("hermes_cli.sqlite_util")

        def add_column_if_missing(conn, table, column, ddl):
            try:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")
                return True
            except sqlite3.OperationalError as exc:
                if "duplicate column name" in str(exc).lower():
                    return False
                raise

        util.add_column_if_missing = add_column_if_missing
        pkg.sqlite_util = util
        sys.modules["hermes_cli"] = pkg
        sys.modules["hermes_cli.sqlite_util"] = util


_PINNED_LOADED = False


def load_pinned():
    """Verify hashes, install shims, import the pinned modules. Returns (store_mod, retrieval_mod, threat_mod)."""
    global _PINNED_LOADED
    verify_pins()
    _install_hermes_shims()
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    from pinned import store as store_mod, retrieval as retrieval_mod, threat_patterns as threat_mod
    _PINNED_LOADED = True
    return store_mod, retrieval_mod, threat_mod


_store_mod, _retrieval_mod, _threat_mod = load_pinned()
scan_for_threats = _threat_mod.scan_for_threats
first_threat_message = _threat_mod.first_threat_message

# ---------------------------------------------------------------------------
# Built-in memory (port of tools/memory_tool_store.py)
# ---------------------------------------------------------------------------

MEMORY_BLOCK_HEADERS = {"memory": "MEMORY (your personal notes)", "user": "USER PROFILE (who the user is)"}
ENTRY_DELIMITER = "\n§\n"
DEFAULT_MEMORY_CHAR_LIMIT = 2200
DEFAULT_USER_CHAR_LIMIT = 1375


def _scan_memory_content(content: str) -> Optional[str]:
    return first_threat_message(content, scope="strict")


def _error(message: str, **extra) -> Dict[str, Any]:
    return {"success": False, "error": message, **extra}


def _find_unique_match(entries: List[str], old_text: str) -> Tuple[Optional[int], bool]:
    exact = [i for i, e in enumerate(entries) if e == old_text]
    matches = exact if exact else [i for i, e in enumerate(entries) if old_text in e]
    if len({entries[i] for i in matches}) > 1:
        return None, True
    return (matches[0] if matches else None), False


def _atomic_write_text(path: Path, text: str, prefix: str = ".mem_") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=prefix, dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        with suppress(OSError):
            os.unlink(tmp)
        raise


try:
    import fcntl  # type: ignore
    msvcrt = None
except ImportError:  # Windows
    fcntl = None
    try:
        import msvcrt  # type: ignore
    except ImportError:
        msvcrt = None


@contextmanager
def _file_lock(path: Path):
    """Exclusive lock on <file>.lock so the memory file itself can be atomically replaced."""
    lock_path = path.with_suffix(path.suffix + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    if fcntl is None and msvcrt is None:
        yield
        return
    fd = open(lock_path, "a+", encoding="utf-8")
    with fd:
        def _flock(unlock: bool):
            if fcntl:
                fcntl.flock(fd, fcntl.LOCK_UN if unlock else fcntl.LOCK_EX)
            else:
                fd.seek(0)
                msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK if unlock else msvcrt.LK_LOCK, 1)
        _flock(False)
        try:
            yield
        finally:
            with suppress(OSError):
                _flock(True)


class BuiltinMemory:
    """Bounded, file-backed MEMORY.md / USER.md with the Hermes semantics: whole-entry
    replace, exact-match priority, ambiguity refusal, atomic all-or-nothing batches,
    strict content scan, drift guard, and refusal to write over an unreadable file."""

    def __init__(self, memories_dir: Path, memory_char_limit: int = DEFAULT_MEMORY_CHAR_LIMIT,
                 user_char_limit: int = DEFAULT_USER_CHAR_LIMIT):
        self.dir = Path(memories_dir)
        self.limits = {"memory": int(memory_char_limit), "user": int(user_char_limit)}
        self._lock = threading.RLock()

    # -- paths / parsing ---------------------------------------------------
    def path_for(self, target: str) -> Path:
        return self.dir / ("USER.md" if target == "user" else "MEMORY.md")

    @staticmethod
    def _parse(raw: str) -> List[str]:
        return [e for e in (x.strip() for x in raw.split(ENTRY_DELIMITER)) if e]

    @staticmethod
    def _read_raw_checked(path: Path) -> Tuple[str, bool]:
        if not path.exists():
            return "", True
        try:
            return path.read_text(encoding="utf-8-sig"), True
        except (OSError, UnicodeDecodeError):
            return "", False

    def entries(self, target: str) -> List[str]:
        raw, _ = self._read_raw_checked(self.path_for(target))
        return list(dict.fromkeys(self._parse(raw)))

    def _usage(self, target: str, entries: List[str]) -> str:
        return f"{len(ENTRY_DELIMITER.join(entries)):,}/{self.limits[target]:,}"

    def _usage_pct(self, target: str, current: int) -> str:
        limit = self.limits[target]
        return f"{min(100, int((current / limit) * 100)) if limit > 0 else 0}% — {current:,}/{limit:,} chars"

    def _success(self, target: str, entries: List[str], message: str = None, **extra) -> Dict[str, Any]:
        return {"success": True, "done": True, "target": target,
                "usage": self._usage_pct(target, len(ENTRY_DELIMITER.join(entries))),
                "entry_count": len(entries), **({"message": message} if message else {}), **extra,
                "note": "Write saved. This update is complete — do not repeat it."}

    def _detect_drift(self, target: str, raw: str) -> Optional[str]:
        parsed = self._parse(raw)
        if not raw.strip() or (raw.strip() == ENTRY_DELIMITER.join(parsed)
                               and max(map(len, parsed), default=0) <= self.limits[target]):
            return None
        path = self.path_for(target)
        bak = path.with_suffix(path.suffix + f".bak.{int(time.time())}")
        try:
            bak.write_text(raw, encoding="utf-8")
        except OSError:
            return str(bak) + " (BACKUP FAILED — file unchanged on disk)"
        return str(bak)

    # -- locked read-modify-write -----------------------------------------
    def _mutate(self, target: str, mutate, *, skip_drift: bool = False) -> Dict[str, Any]:
        path = self.path_for(target)
        with self._lock, _file_lock(path):
            raw, ok = self._read_raw_checked(path)
            if not ok:
                return _error(f"Refusing to write {path.name}: the file exists on disk but could not be read "
                              f"right now. Treating an unreadable file as empty and saving would wipe existing "
                              f"memory, so the write is refused. Nothing was changed — retry in a moment.")
            bak = None if skip_drift else self._detect_drift(target, raw)
            entries = list(dict.fromkeys(self._parse(raw)))
            if bak:
                return _error(f"Refusing to write {path.name}: file on disk has content that wouldn't round-trip "
                              f"through the memory tool. A snapshot was saved to {bak}. Rewrite the file as a "
                              f"clean §-delimited list of entries, then retry.", drift_backup=bak)
            result = mutate(entries, self.limits[target])
            if isinstance(result, dict):
                return result
            new_entries = result[0]
            _atomic_write_text(path, ENTRY_DELIMITER.join(new_entries))
            extra = result[2] if len(result) > 2 else {}
            return self._success(target, new_entries, result[1], **extra)

    def add(self, target: str, content: str) -> Dict[str, Any]:
        content = (content or "").strip()
        if not content:
            return _error("Content cannot be empty.")
        if scan_error := _scan_memory_content(content):
            return _error(scan_error)

        def _add(entries, limit):
            if content in entries:
                return self._success(target, entries, "Entry already exists (no duplicate added).")
            if len(ENTRY_DELIMITER.join(entries + [content])) > limit:
                return _error(
                    f"Memory at {len(ENTRY_DELIMITER.join(entries)):,}/{limit:,} chars. Adding this entry "
                    f"({len(content)} chars) would exceed the limit. Consolidate now: use 'replace' to merge "
                    f"overlapping entries into shorter ones or 'remove' stale or less important entries (see "
                    f"current_entries below), then retry this add — all in this turn.",
                    current_entries=entries, usage=self._usage(target, entries))
            return entries + [content], "Entry added."
        return self._mutate(target, _add, skip_drift=True)

    def _locate(self, entries, old_text, verb):
        idx, ambiguous = _find_unique_match(entries, old_text)
        if ambiguous:
            return _error(f"Multiple entries matched '{old_text}'. Be more specific.",
                          matches=[e[:80] + ("..." if len(e) > 80 else "") for e in entries if old_text in e])
        if idx is None:
            return _error(f"No entry matched '{old_text}'. Check current_entries below and retry with the exact "
                          f"text of the entry you want to {verb}.", current_entries=entries)
        return idx

    def _edit(self, target: str, old_text: str, new_content: Optional[str]) -> Dict[str, Any]:
        def _apply(entries, limit):
            idx = self._locate(entries, old_text, "replace" if new_content else "remove")
            if isinstance(idx, dict):
                return idx
            replaced = entries[:idx] + ([] if new_content is None else [new_content]) + entries[idx + 1:]
            if new_content is None:
                return replaced, "Entry removed.", {"removed_entry": entries[idx]}
            new_total = len(ENTRY_DELIMITER.join(replaced))
            if new_total > limit:
                return _error(f"Replacement would put memory at {new_total:,}/{limit:,} chars. Shorten the new "
                              f"content, or 'remove' other stale or less important entries to make room (see "
                              f"current_entries below), then retry — all in this turn.",
                              current_entries=entries, usage=self._usage(target, entries))
            return replaced, "Entry replaced.", {"replaced_entry": entries[idx]}
        return self._mutate(target, _apply)

    def replace(self, target: str, old_text: str, new_content: str) -> Dict[str, Any]:
        new_content = (new_content or "").strip()
        if not (old_text or "").strip():
            return _error("old_text cannot be empty.")
        if not new_content:
            return _error("new_content cannot be empty. Use 'remove' to delete entries.")
        if scan_error := _scan_memory_content(new_content):
            return _error(scan_error)
        return self._edit(target, old_text.strip(), new_content)

    def remove(self, target: str, old_text: str) -> Dict[str, Any]:
        if not (old_text or "").strip():
            return _error("old_text cannot be empty.")
        return self._edit(target, old_text.strip(), None)

    def apply_batch(self, target: str, operations: List[Dict[str, Any]]) -> Dict[str, Any]:
        if not operations:
            return _error("operations list is empty.")
        ops = [op or {} for op in operations]
        for i, op in enumerate(ops):
            scan_error = op.get("action") in {"add", "replace"} and op.get("content") and _scan_memory_content(op["content"])
            if scan_error:
                return _error(f"Operation {i + 1}: {scan_error}")
            nt = op.get("new_text")
            if op.get("action") in {"add", "replace"} and not op.get("content") and nt and (se := _scan_memory_content(nt)):
                return _error(f"Operation {i + 1}: {se}")

        def fail(entries, msg):
            return _error(msg + " No operations were applied (batch is all-or-nothing).",
                          usage=self._usage(target, entries))

        def _apply(entries, limit):
            working, matched = list(entries), []
            for i, op in enumerate(ops):
                act = op.get("action")
                content = (op.get("content") or op.get("new_text") or "").strip()
                old = (op.get("old_text") or "").strip()
                pos = f"Operation {i + 1} ({act or 'unknown'})"
                prev = None
                if act == "add":
                    if not content:
                        return fail(entries, f"{pos}: content is required.")
                    if content not in working:
                        working.append(content)
                elif act in ("replace", "remove"):
                    if not old:
                        return fail(entries, f"{pos}: old_text is required.")
                    if act == "replace" and not content:
                        return fail(entries, f"{pos}: content is required (use action='remove' to delete).")
                    idx, ambiguous = _find_unique_match(working, old)
                    if ambiguous:
                        return fail(entries, f"{pos}: '{old}' matched multiple distinct entries -- be more specific.")
                    if idx is None:
                        return fail(entries, f"{pos}: no entry matched '{old}'.")
                    prev = working[idx]
                    working[idx:idx + 1] = [content] if act == "replace" else []
                else:
                    return fail(entries, f"{pos}: unknown action. Use add, replace, or remove.")
                matched.append(prev)
            if entries and not working:
                return fail(entries, f"Refusing to empty {self.path_for(target).name}: this batch would remove every "
                                     f"entry from a previously non-empty store. Keep at least one entry. To delete "
                                     f"the final entry deliberately, use single remove() calls.")
            new_total = len(ENTRY_DELIMITER.join(working))
            if new_total > limit:
                return fail(entries, f"After applying all {len(operations)} operations, memory would be at "
                                     f"{new_total:,}/{limit:,} chars -- over the limit. Remove or shorten more "
                                     f"entries in the same batch, then retry.")
            replaced, removed = {}, {}
            for i, (op, prev) in enumerate(zip(ops, matched), 1):
                if prev is not None:
                    (replaced if op.get("action") == "replace" else removed)[i] = prev
            extra = {"replaced_entries": replaced} if replaced else {}
            if removed:
                extra["removed_entries"] = removed
            return working, f"Applied {len(operations)} operation(s).", extra
        return self._mutate(target, _apply)

    # -- rendering -----------------------------------------------------------
    def render_block(self, target: str) -> str:
        """Hermes system-prompt block. Entries matching a threat pattern are replaced by a
        [BLOCKED: ...] placeholder (the file keeps the raw text so it can be removed)."""
        name = self.path_for(target).name
        shown = []
        for e in self.entries(target):
            findings = scan_for_threats(e, scope="strict") if e and not e.startswith("[BLOCKED:") else None
            shown.append(e if not findings else
                         f"[BLOCKED: {name} entry contained threat pattern(s): {', '.join(findings)}. "
                         f"Removed from system prompt; use memory(action=remove) to delete the original.]")
        if not shown:
            return ""
        content, sep = ENTRY_DELIMITER.join(shown), "═" * 46
        return f"{sep}\n{MEMORY_BLOCK_HEADERS[target]} [{self._usage_pct(target, len(content))}]\n{sep}\n{content}"


MEMORY_SCHEMA = {
    "name": "memory",
    "description": (
        "Save durable facts to persistent memory that survive across sessions. Memory is "
        "injected into every future run, so keep entries compact and high-signal.\n\n"
        "HOW: make ALL your changes in ONE call via an 'operations' array (each item: "
        "{action, content?, old_text?}). The batch applies atomically and the char limit is "
        "checked only on the FINAL result — so a single call can remove/replace stale entries "
        "to free room AND add new ones, even when an add alone would overflow. The response "
        "reports current/limit chars and confirms completion; one batch call finishes the "
        "update, so don't repeat it. Use the bare action/content/old_text fields only for a "
        "single lone change.\n\n"
        "WHEN: only for facts that apply to EVERY session regardless of task: who the user "
        "is, stable environment facts, standing conventions with no task home. Detailed or "
        "task-specific facts belong in fact_store, where they are recalled only when relevant; "
        "memory is injected into every run and must stay small.\n\n"
        "IF FULL: an add is rejected with the current entries shown. Reissue as ONE batch that "
        "removes or shortens enough stale entries and adds the new one together.\n\n"
        "TARGETS: 'user' = who the user is (name, role, preferences, style). 'memory' = your "
        "notes (environment, conventions, tool quirks, lessons).\n\n"
        "SKIP: trivial/obvious info, easily re-discovered facts, raw data dumps, task progress, "
        "completed-work logs, temporary TODO state (use session_search for those)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["add", "replace", "remove"],
                       "description": "The action to perform (single-op shape). Omit when using 'operations'."},
            "target": {"type": "string", "enum": ["memory", "user"],
                       "description": "Which memory store: 'memory' for personal notes, 'user' for user profile."},
            "content": {"type": "string", "description": (
                "The entry content. Required for 'add' and 'replace'. For 'replace' it is the COMPLETE new entry "
                "text: the whole matched entry is overwritten, so include everything you want to keep. Alias: "
                "'new_text' is also accepted (same full-entry meaning).")},
            "old_text": {"type": "string", "description": (
                "REQUIRED for 'replace' and 'remove' (single-op shape): a short unique substring IDENTIFYING the "
                "existing entry to modify -- it locates the entry, it is not spliced out. Omit only for 'add'.")},
            "new_text": {"type": "string", "description": (
                "Alias for 'content' (single-op shape): the COMPLETE new entry for 'replace', not a patch of "
                "old_text. If both are set, 'content' wins.")},
            "operations": {
                "type": "array",
                "description": ("Batch shape: a list of operations applied atomically in one call against the "
                                "final char budget. Preferred when making multiple changes or consolidating to "
                                "make room. Each item is {action, content?, old_text?}."),
                "items": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["add", "replace", "remove"]},
                        "content": {"type": "string", "description": "Entry content for add/replace. For replace, the COMPLETE new entry (whole entry is overwritten). Alias: 'new_text'."},
                        "new_text": {"type": "string", "description": "Alias for 'content' in a batch op."},
                        "old_text": {"type": "string", "description": "Substring identifying the entry for replace/remove."},
                    },
                    "required": ["action"],
                },
            },
        },
        "required": ["target"],
    },
}

# ---------------------------------------------------------------------------
# Holographic plugin (tool schemas + handlers ported from plugins/memory/holographic/__init__.py)
# ---------------------------------------------------------------------------

FACT_STORE_SCHEMA = {
    "name": "fact_store",
    "description": (
        "Deep structured memory with algebraic reasoning. Use alongside the memory tool — memory for always-on "
        "context, fact_store for deep recall and compositional queries.\n\nACTIONS (simple → powerful):\n"
        "• add — Store a fact the user would expect you to remember.\n• search — Keyword lookup ('editor config', 'deploy process').\n"
        "• probe — Entity recall: ALL facts about a person/thing.\n• related — What connects to an entity? Structural adjacency.\n"
        "• reason — Compositional: facts connected to MULTIPLE entities simultaneously.\n"
        "• contradict — Memory hygiene: find facts making conflicting claims.\n• update/remove/list — CRUD operations.\n\n"
        "IMPORTANT: Before answering questions about the user, ALWAYS probe or reason first."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["add", "search", "probe", "related", "reason", "contradict", "update", "remove", "list"]},
            "content": {"type": "string", "description": "Fact content (required for 'add')."},
            "query": {"type": "string", "description": "Search query (required for 'search')."},
            "entity": {"type": "string", "description": "Entity name for 'probe'/'related'."},
            "entities": {"type": "array", "items": {"type": "string"}, "description": "Entity names for 'reason'."},
            "fact_id": {"type": "integer", "description": "Fact ID for 'update'/'remove'."},
            "category": {"type": "string", "enum": ["user_pref", "project", "tool", "general"]},
            "tags": {"type": "string", "description": "Comma-separated tags."},
            "trust_delta": {"type": "number", "description": "Trust adjustment for 'update'."},
            "min_trust": {"type": "number", "description": "Minimum trust filter (default: 0.3)."},
            "limit": {"type": "integer", "description": "Max results (default: 10)."},
        },
        "required": ["action"],
    },
}

FACT_FEEDBACK_SCHEMA = {
    "name": "fact_feedback",
    "description": ("Rate a fact after using it. Mark 'helpful' if accurate, 'unhelpful' if outdated. "
                    "This trains the memory — good facts rise, bad facts sink."),
    "parameters": {
        "type": "object",
        "properties": {"action": {"type": "string", "enum": ["helpful", "unhelpful"]},
                       "fact_id": {"type": "integer", "description": "The fact ID to rate."}},
        "required": ["action", "fact_id"],
    },
}

# Verbatim from the plugin's _EXTRACT_CATEGORIES (user preferences -> user_pref, decisions -> project).
_EXTRACT_CATEGORIES = (
    ([re.compile(r'\bI\s+(?:prefer|like|love|use|want|need)\s+(.+)', re.IGNORECASE),
      re.compile(r'\bmy\s+(?:favorite|preferred|default)\s+\w+\s+is\s+(.+)', re.IGNORECASE),
      re.compile(r'\bI\s+(?:always|never|usually)\s+(.+)', re.IGNORECASE)], "user_pref"),
    ([re.compile(r'\bwe\s+(?:decided|agreed|chose)\s+(?:to\s+)?(.+)', re.IGNORECASE),
      re.compile(r'\bthe\s+project\s+(?:uses|needs|requires)\s+(.+)', re.IGNORECASE)], "project"),
)


def is_compaction_summary_message(msg: Dict[str, Any]) -> bool:
    """Stub for Hermes agent.context_compressor.is_compaction_summary_message. Nimbus has no
    Hermes compactor; a host may flag its own summaries with any of these keys."""
    return bool(msg.get("compaction_summary") or msg.get("_compressed_summary") or msg.get("is_summary"))


def _tool_error(message: str) -> str:
    return json.dumps({"error": message}, ensure_ascii=False)


def _results(items: list, key: str = "results") -> str:
    return json.dumps({key: items, "count": len(items)}, default=str)


class FactMemory:
    """Holographic fact store over <home>/memory_store.db using the pinned modules."""

    def __init__(self, db_path: Path, default_trust: float = 0.5, hrr_dim: int = 1024, hrr_weight: float = 0.3,
                 temporal_decay_half_life: int = 0, min_trust: float = 0.3):
        self.db_path = Path(db_path)
        self.store = _store_mod.MemoryStore(db_path=str(self.db_path), default_trust=default_trust, hrr_dim=hrr_dim)
        self.retriever = _retrieval_mod.FactRetriever(store=self.store, hrr_dim=hrr_dim, hrr_weight=hrr_weight,
                                                      temporal_decay_half_life=temporal_decay_half_life)
        self.min_trust = float(min_trust)

    def close(self):
        self.store.close()

    def _limit(self, a):
        return int(a.get("limit", 10))

    def _entity_query(self, method, a):
        return _results(getattr(self.retriever, method)(a["entity"], category=a.get("category"), limit=self._limit(a)))

    def fact_store(self, a: Dict[str, Any]) -> str:
        s, r = self.store, self.retriever
        actions = {
            "add": lambda: json.dumps({"fact_id": s.add_fact(a["content"], category=a.get("category", "general"),
                                                             tags=a.get("tags", "")), "status": "added"}),
            "search": lambda: _results(r.search(a["query"], category=a.get("category"),
                                                min_trust=float(a.get("min_trust", self.min_trust)), limit=self._limit(a))),
            "probe": lambda: self._entity_query("probe", a),
            "related": lambda: self._entity_query("related", a),
            "reason": lambda: _results(r.reason(a["entities"], category=a.get("category"), limit=self._limit(a)))
            if a.get("entities") else _tool_error("reason requires 'entities' list"),
            "contradict": lambda: _results(r.contradict(category=a.get("category"), limit=self._limit(a))),
            "update": lambda: json.dumps({"updated": s.update_fact(
                int(a["fact_id"]), content=a.get("content"),
                trust_delta=float(a["trust_delta"]) if "trust_delta" in a else None,
                tags=a.get("tags"), category=a.get("category"))}),
            "remove": lambda: json.dumps({"removed": s.remove_fact(int(a["fact_id"]))}),
            "list": lambda: _results(s.list_facts(category=a.get("category"), min_trust=float(a.get("min_trust", 0.0)),
                                                  limit=self._limit(a)), key="facts"),
        }
        action = a.get("action")
        if action not in actions:
            return _tool_error(f"Unknown action: {action}")
        return actions[action]()

    def fact_feedback(self, a: Dict[str, Any]) -> str:
        return json.dumps(self.store.record_feedback(int(a["fact_id"]), helpful=a["action"] == "helpful"))

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        """Mirror built-in memory writes as facts (the plugin mirrors 'add' only)."""
        if action == "add" and content:
            try:
                self.store.add_fact(content, category="user_pref" if target == "user" else "general")
            except Exception as e:
                logger.debug("memory_write mirror failed: %s", e)

    def prefetch(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        if not query:
            return []
        out = []
        for r in self.retriever.search(query, min_trust=self.min_trust, limit=limit):
            out.append({"fact_id": r.get("fact_id"), "content": r.get("content", ""), "category": r.get("category"),
                        "trust": r.get("trust_score"), "score": r.get("score")})
        return out

    def auto_extract(self, messages: List[Dict[str, Any]], *, max_messages: int = 500, max_facts: int = 50,
                     max_chars: int = 20000, deadline_s: float = 10.0) -> Dict[str, Any]:
        """The plugin's _auto_extract_facts, bounded: message/fact/char caps and a time budget."""
        started = time.monotonic()
        extracted, scanned, errors, truncated = 0, 0, 0, False
        for msg in messages[:max_messages]:
            if time.monotonic() - started > deadline_s or extracted >= max_facts:
                truncated = True
                break
            if not isinstance(msg, dict):
                continue
            content = msg.get("content", "") if msg.get("role") == "user" else None
            if content is None or is_compaction_summary_message(msg):
                continue
            if not isinstance(content, str) or len(content) < 10:
                continue
            scanned += 1
            probe = content[:max_chars]
            for patterns, category in _EXTRACT_CATEGORIES:
                if any(p.search(probe) for p in patterns):
                    try:
                        self.store.add_fact(content[:400], category=category)
                        extracted += 1
                    except Exception:
                        errors += 1
        if len(messages) > max_messages:
            truncated = True
        return {"extracted": extracted, "scanned": scanned, "errors": errors, "truncated": truncated}


# ---------------------------------------------------------------------------
# session_search (read-only FTS over <home>/state.db)
# ---------------------------------------------------------------------------

SESSION_SEARCH_SCHEMA = {
    "name": "session_search",
    "description": (
        "Recall past conversations from the Lumos history copied at cutover (read-only, FTS5). Shapes, picked by "
        "args: `query` = discovery (top matching sessions with their matching messages); `session_id` + "
        "`around_message_id` = scroll (window of messages around an anchor); `session_id` alone = read a session; "
        "no args = browse recent sessions. Results are actual stored messages. Searches conversation history "
        "ONLY — when the user gave a direct source, inspect that first; never conclude 'not found' from history alone."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Keywords, phrases, or FTS5 boolean expression. Omit to browse."},
            "limit": {"type": "integer", "description": "Max sessions to return (default 3, max 10).", "default": 3},
            "sort": {"type": "string", "enum": ["relevance", "newest", "oldest"],
                     "description": "Discovery ordering (default relevance)."},
            "session_id": {"type": "string", "description": "Session to read or scroll inside."},
            "around_message_id": {"type": "integer", "description": "Anchor message id for the scroll shape."},
            "window": {"type": "integer", "description": "Messages around the anchor / per read (default 20, max 100)."},
        },
    },
}

_MSG_CHARS = 1500


class SessionHistory:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)

    def _connect(self) -> sqlite3.Connection:
        if not self.db_path.is_file():
            raise FileNotFoundError(f"no state.db in home ({self.db_path})")
        uri = self.db_path.resolve().as_posix()
        # A static copy without a -wal file: immutable=1 reads it without creating -wal/-shm
        # files beside it. With a -wal present the reader must see it, so plain mode=ro.
        wal = self.db_path.with_name(self.db_path.name + "-wal")
        q = "mode=ro" if wal.exists() else "mode=ro&immutable=1"
        conn = sqlite3.connect(f"file:{uri}?{q}", uri=True, timeout=5.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=1")
        return conn

    @staticmethod
    def _cols(conn, table):
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}

    @staticmethod
    def _msg(row) -> Dict[str, Any]:
        content = row["content"] or ""
        return {"id": row["id"], "role": row["role"], "timestamp": row["timestamp"],
                "content": content[:_MSG_CHARS] + ("…" if len(content) > _MSG_CHARS else "")}

    def _session_meta(self, conn, sid):
        cols = self._cols(conn, "sessions")
        want = [c for c in ("id", "title", "source", "started_at", "ended_at", "message_count") if c in cols]
        row = conn.execute(f"SELECT {', '.join(want)} FROM sessions WHERE id = ?", (sid,)).fetchone()
        return dict(row) if row else {"id": sid}

    @staticmethod
    def _fallback_query(q: str) -> str:
        toks = [t for t in re.findall(r"\w+", q) if t]
        return " OR ".join(f'"{t}"' for t in toks)

    def search(self, a: Dict[str, Any]) -> str:
        try:
            conn = self._connect()
        except Exception as e:
            return json.dumps({"success": False, "error": str(e)})
        try:
            limit = max(1, min(10, int(a.get("limit") or 3)))
            window = max(1, min(100, int(a.get("window") or 20)))
            sid, anchor, query = a.get("session_id"), a.get("around_message_id"), (a.get("query") or "").strip()
            mcols = self._cols(conn, "messages")
            active = " AND m.active = 1" if "active" in mcols else ""
            if sid and anchor is not None:
                half = window // 2
                before = conn.execute(f"SELECT m.id, m.role, m.content, m.timestamp FROM messages m WHERE m.session_id = ? "
                                      f"AND m.id < ?{active} ORDER BY m.id DESC LIMIT ?", (sid, int(anchor), half)).fetchall()
                after = conn.execute(f"SELECT m.id, m.role, m.content, m.timestamp FROM messages m WHERE m.session_id = ? "
                                     f"AND m.id >= ?{active} ORDER BY m.id ASC LIMIT ?", (sid, int(anchor), window - half)).fetchall()
                msgs = [self._msg(r) for r in reversed(before)] + [self._msg(r) for r in after]
                return json.dumps({"success": True, "shape": "scroll", "session": self._session_meta(conn, sid),
                                   "messages": msgs}, default=str)
            if sid:
                rows = conn.execute(f"SELECT m.id, m.role, m.content, m.timestamp FROM messages m WHERE m.session_id = ?"
                                    f"{active} ORDER BY m.id ASC LIMIT ?", (sid, window)).fetchall()
                total = conn.execute("SELECT COUNT(*) FROM messages WHERE session_id = ?", (sid,)).fetchone()[0]
                return json.dumps({"success": True, "shape": "read", "session": self._session_meta(conn, sid),
                                   "messages": [self._msg(r) for r in rows], "total_messages": total,
                                   "truncated": total > len(rows)}, default=str)
            if not query:
                cols = self._cols(conn, "sessions")
                want = [c for c in ("id", "title", "source", "started_at", "message_count") if c in cols]
                rows = conn.execute(f"SELECT {', '.join(want)} FROM sessions ORDER BY started_at DESC LIMIT ?",
                                    (limit,)).fetchall()
                return json.dumps({"success": True, "shape": "browse", "sessions": [dict(r) for r in rows]}, default=str)
            sql = (f"SELECT m.id, m.session_id, m.role, m.content, m.timestamp, f.rank AS rank FROM messages_fts f "
                   f"JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?{active} ORDER BY f.rank LIMIT 400")
            try:
                rows = conn.execute(sql, (query,)).fetchall()
            except sqlite3.OperationalError:
                fq = self._fallback_query(query)
                rows = conn.execute(sql, (fq,)).fetchall() if fq else []
            sessions: Dict[str, Dict[str, Any]] = {}
            for r in rows:
                s = sessions.setdefault(r["session_id"], {"best_rank": r["rank"], "latest": r["timestamp"], "matches": []})
                s["latest"] = max(s["latest"] or 0, r["timestamp"] or 0)
                if len(s["matches"]) < 5:
                    s["matches"].append(self._msg(r))
            order = a.get("sort") or "relevance"
            keyf = {"relevance": lambda kv: kv[1]["best_rank"], "newest": lambda kv: -(kv[1]["latest"] or 0),
                    "oldest": lambda kv: kv[1]["latest"] or 0}.get(order, lambda kv: kv[1]["best_rank"])
            picked = sorted(sessions.items(), key=keyf)[:limit]
            out = [{"session": self._session_meta(conn, k), "matches": v["matches"]} for k, v in picked]
            return json.dumps({"success": True, "shape": "discovery", "query": query, "results": out,
                               "count": len(out)}, default=str)
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# Home + facade
# ---------------------------------------------------------------------------


def resolve_home(home: str) -> Path:
    """A lumos-home generation folder. If given the lumos-home root holding current.json,
    follow the pointer ({"current"|"generation"|"path"|"dir": "gen-<UTC>"})."""
    p = Path(home).expanduser().resolve()
    if not p.is_dir():
        raise FileNotFoundError(f"--home is not a directory: {p}")
    ptr = p / "current.json"
    if not (p / "memories").is_dir() and ptr.is_file():
        data = json.loads(ptr.read_text(encoding="utf-8-sig"))
        for key in ("current", "generation", "path", "dir"):
            if isinstance(data.get(key), str):
                target = Path(data[key])
                target = target if target.is_absolute() else p / target
                if target.is_dir():
                    return target.resolve()
        raise FileNotFoundError(f"current.json in {p} does not name an existing generation folder")
    return p


class LumosMemory:
    def __init__(self, home: str, render_path: Optional[str] = None, *,
                 memory_char_limit: int = DEFAULT_MEMORY_CHAR_LIMIT, user_char_limit: int = DEFAULT_USER_CHAR_LIMIT,
                 default_trust: float = 0.5, min_trust: float = 0.3, hrr_dim: int = 1024, hrr_weight: float = 0.3,
                 temporal_decay_half_life: int = 0, facts: bool = True):
        self.home = resolve_home(home)
        self.render_path = Path(render_path).resolve() if render_path else None
        self.builtin = BuiltinMemory(self.home / "memories", memory_char_limit, user_char_limit)
        self.facts = FactMemory(self.home / "memory_store.db", default_trust, hrr_dim, hrr_weight,
                                temporal_decay_half_life, min_trust) if facts else None
        self.history = SessionHistory(self.home / "state.db")
        self._lock = threading.RLock()

    def close(self):
        if self.facts:
            self.facts.close()

    # -- render ----------------------------------------------------------------
    def render_text(self) -> str:
        blocks = [b for b in (self.builtin.render_block("memory"), self.builtin.render_block("user")) if b]
        return ("\n\n".join(blocks) + "\n") if blocks else ""

    def render(self) -> Optional[str]:
        if not self.render_path:
            return None
        _atomic_write_text(self.render_path, self.render_text(), prefix=".render_")
        return str(self.render_path)

    # -- memory tool -------------------------------------------------------------
    def memory(self, args: Dict[str, Any]) -> str:
        with self._lock:
            action, target = args.get("action"), args.get("target")
            target = "memory" if target is None else target
            content, old_text, operations = args.get("content"), args.get("old_text"), args.get("operations")
            if content is None and args.get("new_text") is not None:
                content = args["new_text"]
            if target not in ("memory", "user"):
                return json.dumps({"success": False, "error": f"Invalid memory target '{target}'. Use 'memory' or 'user'."})
            b = self.builtin
            if operations:
                if not isinstance(operations, list):
                    return json.dumps(_error("operations must be a list of {action, content?, old_text?} objects."))
                result = b.apply_batch(target, operations)
                ops = operations
            else:
                if action not in ("add", "replace", "remove"):
                    return json.dumps(_error(f"Unknown action '{action}'. Use: add, replace, remove"))
                if action == "add" and not content:
                    return json.dumps(_error("Content is required for 'add' action."))
                if action in ("replace", "remove") and not old_text:
                    return json.dumps({"success": False, "error": (
                        f"'{action}' needs old_text -- a short unique substring of the entry to {action}. None was "
                        f"provided. Reissue the {action} with old_text set to part of one of the current_entries below."),
                        "current_entries": b.entries(target),
                        "usage": b._usage(target, b.entries(target))}, ensure_ascii=False)
                if action == "replace" and not content:
                    return json.dumps(_error("content is required for 'replace' action."))
                result = (b.add(target, content) if action == "add" else
                          b.replace(target, old_text, content) if action == "replace" else b.remove(target, old_text))
                ops = [{"action": action, "content": content, "old_text": old_text}]
            if result.get("success") is True:
                if self.facts:
                    for op in ops:
                        if isinstance(op, dict):
                            self.facts.on_memory_write(str(op.get("action") or ""), target,
                                                       str(op.get("content") or op.get("new_text") or ""))
                try:
                    rendered = self.render()
                    if rendered:
                        result["rendered"] = rendered
                except OSError as e:
                    result["render_error"] = str(e)
            return json.dumps(result, ensure_ascii=False)

    def fact_store(self, args):
        if not self.facts:
            return _tool_error("fact store disabled")
        with self._lock:
            try:
                return self.facts.fact_store(args)
            except KeyError as exc:
                return _tool_error(f"Missing required argument: {exc}")
            except Exception as exc:
                return _tool_error(str(exc))

    def fact_feedback(self, args):
        if not self.facts:
            return _tool_error("fact store disabled")
        with self._lock:
            try:
                return self.facts.fact_feedback(args)
            except KeyError as exc:
                return _tool_error(f"Missing required argument: {exc}")
            except Exception as exc:
                return _tool_error(str(exc))

    def session_search(self, args):
        try:
            return self.history.search(args)
        except Exception as exc:
            return json.dumps({"success": False, "error": str(exc)})

    TOOLS = {"memory": MEMORY_SCHEMA, "fact_store": FACT_STORE_SCHEMA, "fact_feedback": FACT_FEEDBACK_SCHEMA,
             "session_search": SESSION_SEARCH_SCHEMA}

    def call(self, name: str, args: Dict[str, Any]) -> str:
        handler = {"memory": self.memory, "fact_store": self.fact_store, "fact_feedback": self.fact_feedback,
                   "session_search": self.session_search}.get(name)
        if handler is None:
            return _tool_error(f"Unknown tool: {name}")
        return handler(dict(args or {}))
