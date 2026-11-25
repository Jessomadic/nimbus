"""Read-only, local inventory of Lumos's durable memory, not model internals.

Only explicitly named profile stores are opened. No Hermes imports, remote
requests, schema initialization, credential vault, or inference are involved.
"""
from __future__ import annotations

import copy
from contextlib import contextmanager
from collections import Counter, defaultdict
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import threading
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

KINDS = ("memory", "entity", "conversation", "skill", "note", "link", "document")
MAX_ROWS = 50000
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_BODY = 500000
_URL_RE = re.compile(r"https?://[^\s<>\"'`\]\[{}]+", re.I)
_TOKEN_PARAM = re.compile(r"(?:token|secret|password|passwd|api.?key|authorization|credential|signature|session|code|ticket|key)", re.I)
_SECRET_ASSIGN = re.compile(r"(?im)(\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|client[_ -]?secret|authorization)\b\s*[:=]\s*)(?:\"[^\"\n]*\"|'[^'\n]*'|[^\s,;\n]+)")
_KEY = re.compile(r"\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{25,}|AKIA[A-Z0-9]{16})\b")
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _timestamp(value):
    if value is None or value == "":
        return None
    try:
        if isinstance(value, (int, float)):
            value = float(value)
            if value > 100000000000:
                value /= 1000
            return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat()
        text = str(value)
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.isoformat()
    except (ValueError, OverflowError, OSError):
        return None


def safe_url(value):
    """Normalize literal web URLs, dropping authentication and signed parameters."""
    try:
        value = str(value).rstrip(".,;:!?")
        while value.endswith(")") and value.count(")") > value.count("("):
            value = value[:-1]
        parts = urlsplit(value)
        if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
            return None
        if parts.username is not None or parts.password is not None:
            return None
        if any(ord(c) < 32 for c in str(value)):
            return None
        host = parts.hostname.encode("idna").decode("ascii").lower()
        if ":" in host:
            host = "[" + host + "]"
        port = parts.port
        if port and not (parts.scheme.lower() == "http" and port == 80) and not (parts.scheme.lower() == "https" and port == 443):
            host += ":" + str(port)
        query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                 if not _TOKEN_PARAM.search(k) and not _KEY.search(v) and not _JWT.search(v)]
        fragment = parts.fragment if not _TOKEN_PARAM.search(parts.fragment) else ""
        if _KEY.search(parts.path) or _JWT.search(parts.path):
            return None
        return urlunsplit((parts.scheme.lower(), host, parts.path or "/", urlencode(query), fragment))
    except (ValueError, UnicodeError):
        return None


def sanitize(value):
    text = str(value or "")
    text = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----", "[private key omitted]", text, flags=re.S)
    text = re.sub(r"<(?:think|analysis|reasoning)(?:\s[^>]*)?>.*?</(?:think|analysis|reasoning)>", "[hidden reasoning omitted]", text, flags=re.S | re.I)
    text = re.sub(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer [redacted]", text, flags=re.I)
    text = _SECRET_ASSIGN.sub(lambda m: m.group(1) + "[redacted]", text)
    text = _KEY.sub("[redacted credential]", text)
    text = _JWT.sub("[redacted token]", text)
    text = _URL_RE.sub(lambda m: safe_url(m.group(0)) or "[credential URL omitted]", text)
    return text


def _visible_content(value):
    """Visible text only when a content column is a structured message payload."""
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return value
    else:
        parsed = value
    if isinstance(parsed, list):
        return "\n".join(_visible_content(p) for p in parsed)
    if isinstance(parsed, dict):
        if parsed.get("role") in ("tool", "system", "developer"):
            return "[non-dialogue payload omitted]"
        if parsed.get("type") in ("text", "input_text", "output_text"):
            return parsed.get("text", "") if isinstance(parsed.get("text"), str) else ""
        if parsed.get("type"):
            return ""
        return _visible_content(parsed.get("content", parsed.get("answer", "")))
    return value if isinstance(value, str) else ""


class BrainData:
    def __init__(self, home, archive=None, cache_seconds=10):
        self.home = Path(home).resolve()
        self.archive = Path(archive).resolve() if archive else None
        self.cache_seconds = max(0, float(cache_seconds))
        self._lock = threading.RLock()
        self._loaded_at = 0
        self._fingerprint = None
        self._records = {}
        self._edges = []
        self._sources = []
        self._warnings = []
        self._updated_at = None
        self._knowledge_documents = {}
        self._knowledge_tags = {}
        self._knowledge_terms = {}

    @staticmethod
    def _id(source, table, key):
        return hashlib.sha256((source + "\0" + table + "\0" + str(key)).encode("utf-8")).hexdigest()[:24]

    def _guard(self, root, relative):
        path = root / relative
        resolved = path.resolve()
        if not resolved.is_relative_to(root):
            raise ValueError("Source path escapes its explicitly configured root")
        # Reparse/symlink ancestors can be swapped; never deliberately traverse one.
        current = path
        while current != root:
            if current.is_symlink():
                raise ValueError("Symlinked source is not admitted")
            current = current.parent
        return path

    def _stat_signature(self):
        paths = [self.home / n for n in ("memory_store.db", "memory_store.db-wal", "state.db", "state.db-wal", "SOUL.md", "memories/MEMORY.md", "memories/USER.md", "skills/.usage.json", "skills/.bundled_manifest", "state/knowledge-base/knowledge.sqlite3", "state/knowledge-base/knowledge.sqlite3-wal")]
        skills = self.home / "skills"
        if skills.is_dir() and not skills.is_symlink():
            paths.extend(skills.rglob("SKILL.md"))
        if self.archive:
            paths.extend(self.archive / n for n in ("memory.db", "memory.db-wal", "chunks.db", "chunks.db-wal"))
        paths.extend(self.home / n for n in ("state/brain-links/links.sqlite3", "state/brain-links/links.sqlite3-wal"))
        values = []
        for path in paths:
            try:
                st = path.stat()
                values.append((str(path), st.st_mtime_ns, st.st_size))
            except OSError:
                values.append((str(path), None, None))
        return tuple(values)

    def _refresh(self):
        with self._lock:
            signature = self._stat_signature()
            if self._updated_at and signature == self._fingerprint and time.monotonic() - self._loaded_at < self.cache_seconds:
                return
            self._records, self._edges, self._sources, self._warnings = {}, [], [], []
            self._knowledge_documents, self._knowledge_tags, self._knowledge_terms = {}, {}, {}
            self._native_facts()
            self._notes()
            self._skills()
            self._sessions()
            self._archives()
            self._knowledge()
            self._links()
            from concept_graph import build_concepts
            build_concepts(self)
            self._reasoned_links()
            known = set(self._records)
            self._edges = list({(e["source"], e["target"], e["relationship"], e["type"]): e for e in self._edges if e["source"] in known and e["target"] in known}.values())
            degrees = Counter()
            for edge in self._edges:
                degrees[edge["source"]] += 1
                degrees[edge["target"]] += 1
            for item in self._records.values():
                item["related_count"] = degrees[item["id"]]
            self._updated_at, self._loaded_at = _now(), time.monotonic()
            self._fingerprint = signature

    def _source(self, identifier, label, root, relative, loader, historical=False):
        source = {"id": identifier, "label": label, "path": str(root / relative), "status": "historical" if historical else "active", "count": 0, "updated_at": None}
        self._sources.append(source)
        before = len(self._records)
        try:
            path = self._guard(root, relative)
            if not path.exists():
                source["status"] = "missing"
                return
            source["updated_at"] = _timestamp(path.stat().st_mtime)
            loader(path, source)
            source["count"] = len(self._records) - before
        except (OSError, UnicodeError, sqlite3.Error, ValueError, TypeError) as exc:
            source["status"] = "unavailable"
            self._warnings.append(label + " could not be fully read (" + type(exc).__name__ + "). Other stores remain available.")
            source["count"] = len(self._records) - before

    @contextmanager
    def _connect(self, path):
        # Short, read-only connections include committed live WAL, unlike immutable=1.
        conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=1, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        try:
            yield conn
        finally:
            conn.close()

    def _rows(self, conn, table, columns, where="", params=()):
        names = {r[1] for r in conn.execute('PRAGMA table_info("' + table + '")')}
        if not names:
            return []
        requested = [c for c in columns if c in names]
        query = "SELECT " + ",".join('"' + c + '"' for c in requested) + ' FROM "' + table + '"'
        if where:
            query += " WHERE " + where
        result = [dict(r) for r in conn.execute(query + " LIMIT ?", (*params, MAX_ROWS + 1))]
        if len(result) > MAX_ROWS:
            self._warnings.append(table + " exceeded the " + str(MAX_ROWS) + " row viewer cap; inventory is partial.")
        return result[:MAX_ROWS]

    def _read_text(self, path):
        with path.open("rb") as stream:
            data = stream.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            self._warnings.append(path.name + " exceeded the file-size cap; content is visibly partial.")
            data = data[:MAX_FILE_BYTES]
        return data.decode("utf-8-sig", errors="replace")

    def _add(self, source, table, key, kind, title, body, created=None, updated=None, **metadata):
        identifier = self._id(source["id"], table, key)
        body = sanitize(body)
        if len(body) > MAX_BODY:
            body = body[:MAX_BODY] + "\n[viewer content cap reached]"
            self._warnings.append(source["label"] + " contains a record beyond the content cap; that record is partial.")
            metadata["content_truncated"] = True
        def clean_meta(value):
            if isinstance(value, str):
                return sanitize(value)
            if isinstance(value, dict):
                return {k: clean_meta(v) for k, v in value.items()}
            if isinstance(value, list):
                return [clean_meta(v) for v in value]
            return value
        metadata = clean_meta(metadata)
        self._records[identifier] = {"id": identifier, "title": sanitize(title)[:220] or kind.title(), "kind": kind,
            "body": body, "excerpt": re.sub(r"\s+", " ", body)[:240],
            "source": {"label": source["label"], "path": source["path"], "table": table, "record_id": str(key)},
            "created_at": _timestamp(created), "updated_at": _timestamp(updated),
            "historical": source["status"] == "historical", "metadata": metadata, "related_count": 0}
        if kind == "skill":
            self._records[identifier].update({k: metadata[k] for k in ("skill_origin", "learned", "bundled") if k in metadata})
        return identifier

    def _edge(self, a, b, relationship, edge_type="stored", evidence=""):
        if a and b and a != b:
            self._edges.append({"source": a, "target": b, "relationship": relationship, "type": edge_type, "evidence": sanitize(evidence)})

    def _reasoned_links(self):
        from link_store import RELATIVE, load_edges
        self._source("reasoned-links", "Reasoned connections with source citations", self.home,
                     RELATIVE, lambda path, source: load_edges(self, path))

    def _native_facts(self):
        def load(path, source):
            with self._connect(path) as db:
                facts, entities = {}, {}
                for row in self._rows(db, "facts", ["fact_id", "content", "category", "tags", "trust_score", "retrieval_count", "helpful_count", "created_at", "updated_at"]):
                    body = row.get("content", "")
                    facts[row["fact_id"]] = self._add(source, "facts", row["fact_id"], "memory", body.splitlines()[0][:100] if body else "Memory", body, row.get("created_at"), row.get("updated_at"), **{k: row[k] for k in ("category", "tags", "trust_score", "retrieval_count", "helpful_count") if k in row})
                for row in self._rows(db, "entities", ["entity_id", "name", "entity_type", "aliases", "created_at"]):
                    entities[row["entity_id"]] = self._add(source, "entities", row["entity_id"], "entity", row.get("name", "Entity"), row.get("name", "") + "\nAliases: " + row.get("aliases", ""), row.get("created_at"), entity_type=row.get("entity_type"), extraction="Stored Hermes regex entity extraction, not a verified semantic assertion")
                for row in self._rows(db, "fact_entities", ["fact_id", "entity_id"]):
                    self._edge(facts.get(row["fact_id"]), entities.get(row["entity_id"]), "mentions entity", evidence="memory_store.db fact_entities row")
        self._source("hermes-facts", "Hermes saved facts and entities", self.home, "memory_store.db", load)

    def _notes(self):
        for relative, label, kind in (("memories/MEMORY.md", "Hermes personal notes", "memory"), ("memories/USER.md", "Hermes user profile", "memory"), ("SOUL.md", "Lumos persona", "note")):
            def load(path, source, relative=relative, kind=kind):
                raw = self._read_text(path).replace("\r\n", "\n").replace("\r", "\n")
                chunks = [raw] if relative == "SOUL.md" else [c.strip() for c in raw.split("\n§\n") if c.strip()]
                for i, text in enumerate(chunks):
                    key = str(i) + ":" + hashlib.sha256(text.encode()).hexdigest()[:16]
                    title = "Lumos persona" if relative == "SOUL.md" else text.splitlines()[0].lstrip("# ")[:100]
                    self._add(source, "markdown", key, kind, title, text, updated=path.stat().st_mtime, timestamp_provenance="Whole-file modification time; individual learning date is unknown", persona=relative == "SOUL.md")
            self._source(relative, label, self.home, relative, load)

    def _skills(self):
        def load(root, source):
            usage_path = self._guard(self.home, "skills/.usage.json")
            usage = json.loads(self._read_text(usage_path)) if usage_path.exists() else {}
            if not isinstance(usage, dict):
                usage = {}
            manifest_path = self._guard(self.home, "skills/.bundled_manifest")
            manifest = self._read_text(manifest_path).splitlines() if manifest_path.exists() else []
            manifest_names = {re.sub(r":[0-9a-fA-F]{16,64}$", "", line.strip()).replace("\\", "/") for line in manifest}
            skill_ids, related = {}, []
            for path in sorted(root.rglob("SKILL.md")):
                if any(p.startswith(".") for p in path.relative_to(root).parts):
                    continue
                path = self._guard(self.home, str(path.relative_to(self.home)))
                text = self._read_text(path)
                header = text.split("---", 2)[1] if text.startswith("---") and text.count("---") >= 2 else ""
                fields = {}
                for line in header.splitlines():
                    if ":" in line and not line[:1].isspace():
                        k, v = line.split(":", 1)
                        fields[k.strip()] = v.strip().strip("\"'")
                name = fields.get("name", path.parent.name)
                rec = usage.get(name, {})
                rec = rec if isinstance(rec, dict) else {}
                safe_meta = {k: sanitize(rec[k]) if isinstance(rec[k], str) else rec[k] for k in ("created_by", "created_at", "first_seen_at", "last_used_at", "last_viewed_at", "last_patched_at", "use_count", "state", "pinned", "source") if k in rec and isinstance(rec[k], (str, int, float, bool))}
                learned = rec.get("created_by") in ("agent", "learn") or rec.get("agent_created") is True
                relative_skill = path.parent.relative_to(root).as_posix()
                bundled = bool(manifest_names.intersection((relative_skill, relative_skill + "/SKILL.md", name)))
                origin = "learned" if learned else "bundled" if bundled else "installed" if rec.get("source") == "hub" or rec.get("created_by") == "installed" else "profile (origin not recorded)"
                safe_meta.update(description=sanitize(fields.get("description", "")), category=sanitize(fields.get("category", path.parent.parent.name)), learned=learned, bundled=bundled, skill_origin=origin)
                item_id = self._add(source, "skills", str(path.relative_to(self.home)), "skill", name, text, rec.get("created_at"), path.stat().st_mtime, **safe_meta)
                self._records[item_id]["source"]["path"] = str(path)
                skill_ids[name] = item_id
                relation = fields.get("related_skills", "").strip("[]")
                related.extend((item_id, n.strip().strip("\"'")) for n in relation.split(",") if n.strip())
            for item_id, name in related:
                self._edge(item_id, skill_ids.get(name), "declared related skill", evidence="SKILL.md related_skills frontmatter")
        self._source("skills", "Hermes profile skills", self.home, "skills", load)

    def _sessions(self):
        def load(path, source):
            with self._connect(path) as db:
                rows = self._rows(db, "sessions", ["id", "source", "title", "model", "started_at", "ended_at", "last_activity_at", "parent_session_id", "archived", "hidden", "pinned"])
                messages = self._rows(db, "messages", ["id", "session_id", "role", "content", "timestamp", "active", "compacted", "_compressed_summary"], "role IN ('user','assistant')")
                groups = {}
                for message in messages:
                    groups.setdefault(message["session_id"], []).append(message)
                mapping = {}
                for row in rows:
                    selected = sorted(groups.get(row["id"], []), key=lambda m: (m.get("timestamp", 0), m["id"]))
                    body = []
                    flags = []
                    for message in selected:
                        flag = ", ".join(label for field, label in (("active", "inactive"), ("compacted", "compacted"), ("_compressed_summary", "summary")) if (field == "active" and message.get(field) == 0) or (field != "active" and message.get(field)))
                        body.append(f"{message['role'].title()} · {_timestamp(message.get('timestamp')) or 'unknown date'}" + (" · " + flag if flag else "") + "\n" + _visible_content(message.get("content")))
                        flags.append({k: message[k] for k in ("id", "role", "timestamp", "active", "compacted", "_compressed_summary") if k in message})
                    mapping[row["id"]] = self._add(source, "sessions", row["id"], "conversation", row.get("title") or "Conversation · " + str(row.get("source", "Hermes")), "\n\n".join(body) or "No stored user/assistant dialogue.", row.get("started_at"), row.get("last_activity_at") or row.get("ended_at") or row.get("started_at"), platform=row.get("source"), model=row.get("model"), message_count=len(selected), messages=flags, archived=bool(row.get("archived")), hidden=bool(row.get("hidden")), pinned=bool(row.get("pinned")))
                for row in rows:
                    self._edge(mapping.get(row.get("parent_session_id")), mapping[row["id"]], "parent conversation", evidence="state.db sessions.parent_session_id")
        self._source("sessions", "Hermes conversation history", self.home, "state.db", load)

    def _archives(self):
        if not self.archive:
            return
        doc_ids, conversation_ids = {}, {}
        safe_doc_ids, safe_episode_ids = set(), set()
        def load_memory(path, source):
            with self._connect(path) as db:
                docs = self._rows(db, "memory_docs", ["document_id", "namespace", "title", "content", "source_type", "priority", "tags_json", "category", "session_id", "created_at", "updated_at"])
                raw_count = 0
                for row in docs:
                    raw = row.get("namespace") == "conversation_raw"
                    raw_count += int(raw)
                    body = "Raw archived log content is withheld because its role/tool/reasoning boundaries are unknown. Structured archived user/assistant conversations are displayed separately." if raw else _visible_content(row.get("content", ""))
                    title = ("Raw archived log (content omitted)" if raw else row.get("title") or "Historical note")
                    doc_ids[row["document_id"]] = self._add(source, "memory_docs", row["document_id"], "note", title, body, row.get("created_at"), row.get("updated_at"), namespace=row.get("namespace"), source_type=row.get("source_type"), category=row.get("category"), tags=row.get("tags_json"), withheld=raw, archive_notice="Frozen historical OpenHuman migration snapshot")
                    if not raw:
                        safe_doc_ids.add(str(row["document_id"]))
                if raw_count:
                    self._warnings.append(str(raw_count) + " raw archived OpenHuman logs are metadata-only. Structured user/assistant conversations are shown separately; unknown tool/reasoning content is not exposed.")
                episodes = self._rows(db, "episodic_log", ["id", "session_id", "timestamp", "role", "content"], "role IN ('user','assistant')")
                groups = {}
                for row in episodes:
                    safe_episode_ids.add(str(row["id"]))
                    groups.setdefault(row.get("session_id") or "unassigned", []).append(row)
                for session, messages in groups.items():
                    messages.sort(key=lambda m: (m.get("timestamp", 0), m["id"]))
                    body = "\n\n".join(m["role"].title() + " · " + (_timestamp(m.get("timestamp")) or "unknown date") + "\n" + _visible_content(m.get("content", "")) for m in messages)
                    conversation_ids[session] = self._add(source, "episodic_log", session, "conversation", "Archived OpenHuman conversation", body, messages[0].get("timestamp"), messages[-1].get("timestamp"), message_count=len(messages), platform="OpenHuman historical", archive_notice="Frozen historical OpenHuman migration snapshot")
                for row in docs:
                    self._edge(conversation_ids.get(row.get("session_id")), doc_ids[row["document_id"]], "source conversation", evidence="Archived memory_docs.session_id matches episodic_log.session_id")
                for row in self._rows(db, "conversation_segments", ["segment_id", "session_id", "summary", "start_timestamp", "end_timestamp", "created_at", "updated_at", "status"]):
                    identifier = self._add(source, "conversation_segments", row["segment_id"], "note", "Archived conversation summary", _visible_content(row.get("summary", "")), row.get("created_at"), row.get("updated_at"), start_timestamp=_timestamp(row.get("start_timestamp")), end_timestamp=_timestamp(row.get("end_timestamp")), status=row.get("status"), archive_notice="Frozen historical OpenHuman migration snapshot")
                    self._edge(conversation_ids.get(row.get("session_id")), identifier, "conversation summary", evidence="Archived conversation_segments.session_id")
        self._source("openhuman-memory", "OpenHuman historical memory archive", self.archive, "memory.db", load_memory, historical=True)

        def load_chunks(path, source):
            with self._connect(path) as db:
                chunks = self._rows(db, "mem_tree_chunks", ["id", "source_kind", "source_id", "source_ref", "content", "timestamp_ms", "created_at_ms", "tags_json", "parent_summary_id", "lifecycle_status"])
                summaries = self._rows(db, "mem_tree_summaries", ["id", "tree_id", "tree_kind", "level", "parent_id", "child_ids_json", "content", "topics_json", "time_range_start_ms", "time_range_end_ms", "score", "sealed_at_ms", "deleted", "doc_id", "version_ms"])
                node_ids, entity_ids = {}, {}
                withheld_count = 0
                for row in chunks:
                    if row.get("lifecycle_status") == "deleted":
                        continue
                    source_kind = row.get("source_kind")
                    refs = {str(row.get("source_id") or ""), str(row.get("source_ref") or "")}
                    classified = (source_kind == "document" and bool(refs & safe_doc_ids)) or (source_kind == "chat" and bool(refs & safe_episode_ids))
                    mixed = not classified
                    withheld_count += int(mixed)
                    body = "Archived chunk content is withheld: its source does not positively resolve to a classified non-raw document or a structured user/assistant message. Its stored provenance and relationships remain visible." if mixed else _visible_content(row.get("content", ""))
                    node_ids[row["id"]] = self._add(source, "mem_tree_chunks", row["id"], "note", "Archived Brain chunk · " + str(row.get("source_kind", "unknown")), body, row.get("created_at_ms"), row.get("timestamp_ms"), source_kind=row.get("source_kind"), source_id=row.get("source_id"), source_ref=row.get("source_ref"), tags=row.get("tags_json"), lifecycle_status=row.get("lifecycle_status"), withheld=mixed, archive_notice="Frozen historical OpenHuman migration snapshot")
                if withheld_count:
                    self._warnings.append(str(withheld_count) + " historical Brain chunks have unresolved or mixed source boundaries; their content is withheld, while stored metadata/relations remain visible. Summaries and structured conversations are shown separately.")
                for row in summaries:
                    if row.get("deleted"):
                        continue
                    node_ids[row["id"]] = self._add(source, "mem_tree_summaries", row["id"], "note", "Archived Brain summary · level " + str(row.get("level", "?")), _visible_content(row.get("content", "")), row.get("sealed_at_ms"), row.get("version_ms") or row.get("sealed_at_ms"), tree_id=row.get("tree_id"), tree_kind=row.get("tree_kind"), level=row.get("level"), topics=row.get("topics_json"), score=row.get("score"), time_range_start=_timestamp(row.get("time_range_start_ms")), time_range_end=_timestamp(row.get("time_range_end_ms")), archive_notice="Frozen historical OpenHuman migration snapshot")
                for row in chunks:
                    self._edge(node_ids.get(row.get("parent_summary_id")), node_ids.get(row["id"]), "summary contains chunk", "contains", "Stored mem_tree_chunks.parent_summary_id")
                    self._edge(doc_ids.get(row.get("source_id")), node_ids.get(row["id"]), "source document chunk", evidence="Stored mem_tree_chunks.source_id matches archived document_id")
                for row in summaries:
                    self._edge(node_ids.get(row.get("parent_id")), node_ids.get(row["id"]), "parent summary", "contains", "Stored mem_tree_summaries.parent_id")
                    self._edge(doc_ids.get(row.get("doc_id")), node_ids.get(row["id"]), "source document summary", evidence="Stored mem_tree_summaries.doc_id")
                    try:
                        children = json.loads(row.get("child_ids_json") or "[]")
                    except (ValueError, TypeError):
                        children = []
                    for child in children if isinstance(children, list) else []:
                        if isinstance(child, str):
                            self._edge(node_ids.get(row["id"]), node_ids.get(child), "summary contains child", "contains", "Stored mem_tree_summaries.child_ids_json")
                for row in self._rows(db, "mem_tree_entity_index", ["entity_id", "node_id", "node_kind", "entity_kind", "surface", "timestamp_ms"]):
                    entity = row["entity_id"]
                    if entity not in entity_ids:
                        entity_ids[entity] = self._add(source, "mem_tree_entity_index", entity, "entity", row.get("surface") or "Historical entity", row.get("surface", ""), row.get("timestamp_ms"), entity_kind=row.get("entity_kind"), archive_notice="Frozen historical OpenHuman migration snapshot")
                    self._edge(node_ids.get(row.get("node_id")), entity_ids[entity], "archived entity mention", evidence="Stored mem_tree_entity_index node_id/entity_id")
                for row in self._rows(db, "mem_tree_entity_edges", ["entity_a", "entity_b", "weight", "updated_ms"]):
                    self._edge(entity_ids.get(row["entity_a"]), entity_ids.get(row["entity_b"]), "archived entity co-occurrence", evidence="Stored mem_tree_entity_edges; co-occurrence does not imply semantic truth")
        self._source("openhuman-brain", "OpenHuman historical Brain tree", self.archive, "chunks.db", load_chunks, historical=True)

    def _knowledge(self):
        """Inventory ingested sources; fetch page evidence only when requested.

        The knowledge index is much larger than the Memory Atlas. Loading its
        350k+ chunks into the graph would silently cap or exhaust the reader.
        """
        def load(path, source):
            with self._connect(path) as db:
                documents = self._rows(db, "documents",
                    ["id", "path", "sha256", "kind", "status", "warnings", "error", "updated"])
                tags = self._rows(db, "tags",
                    ["document_id", "field", "value", "evidence", "origin"])
                chunk_counts = dict(db.execute(
                    "SELECT document_id, count(*) FROM chunks GROUP BY document_id"))
                visual_counts = dict(db.execute(
                    "SELECT document_id, count(*) FROM assets WHERE kind IN "
                    "('pdf-page','image','document-image','slide-image','video-frame') "
                    "GROUP BY document_id"))
                reviewed_counts = dict(db.execute(
                    "SELECT document_id, count(*) FROM chunks WHERE method='vision-review' "
                    "GROUP BY document_id"))
            by_document = defaultdict(list)
            for tag in tags:
                if tag.get("field") in {"brand", "model", "device_type", "issue"}:
                    by_document[tag["document_id"]].append(tag)
            for row in documents:
                document_id = row["id"]
                try:
                    warnings = json.loads(row.get("warnings") or "[]")
                    if not isinstance(warnings, list):
                        warnings = []
                except (ValueError, TypeError):
                    warnings = ["Saved coverage warnings could not be decoded"]
                title = Path(row["path"]).name
                summary = (f"Source: {row['path']}\nIndex status: {row['status']}\n"
                           f"Extracted evidence chunks: {chunk_counts.get(document_id, 0)}\n"
                           f"Saved visual assets: {visual_counts.get(document_id, 0)}\n"
                           f"Completed visual review chunks: {reviewed_counts.get(document_id, 0)}")
                if warnings:
                    summary += f"\nCoverage warnings: {len(warnings)}. Open the source fields and page evidence for details."
                if row.get("error"):
                    summary += "\nExtraction error: " + str(row["error"])
                tag_rows = by_document.get(document_id, [])
                if tag_rows:
                    summary += "\nIndexed terms: " + ", ".join(
                        sorted({str(t["value"]) for t in tag_rows}, key=lambda value: (value.casefold(), value))[:35])
                item_id = self._add(source, "documents", document_id, "document",
                    title, summary, updated=row.get("updated"),
                    document_id=document_id, source_file=row["path"],
                    source_sha256=row["sha256"], format=row["kind"],
                    status=row["status"], warning_count=len(warnings),
                    evidence_chunks=chunk_counts.get(document_id, 0),
                    visual_assets=visual_counts.get(document_id, 0),
                    visual_reviews=reviewed_counts.get(document_id, 0),
                    indexed_terms=[{"field": t["field"], "value": t["value"],
                                    "origin": t["origin"], "evidence": t["evidence"]}
                                   for t in tag_rows])
                self._knowledge_documents[document_id] = item_id
                normalized = {(t["field"], str(t["value"]).strip().casefold())
                              for t in tag_rows if str(t["value"]).strip()}
                self._knowledge_tags[document_id] = normalized
                for term in normalized:
                    self._knowledge_terms.setdefault(term, set()).add(document_id)
            from knowledge_graph import build_catalog
            build_catalog(self, source, documents, tags)
        self._source("knowledge-base", "Ingested documents and page evidence",
                     self.home, "state/knowledge-base/knowledge.sqlite3", load)

    def _knowledge_matches(self, q):
        terms = re.findall(r"[\w-]+", str(q), re.UNICODE)[:20]
        if not terms:
            return set()
        expression = " AND ".join('"' + term.replace('"', '""') + '"' for term in terms)
        path = self._guard(self.home, "state/knowledge-base/knowledge.sqlite3")
        if not path.exists():
            return set()
        try:
            with self._connect(path) as db:
                return {row[0] for row in db.execute(
                    "SELECT DISTINCT c.document_id FROM chunk_search "
                    "JOIN chunks c ON c.id=chunk_search.rowid "
                    "WHERE chunk_search MATCH ? LIMIT 50001", (expression,))}
        except sqlite3.Error:
            return set()

    def evidence(self, identifier, q="", offset=0, limit=40):
        """Page/time-cited extraction, OCR, transcript, and visual notes."""
        self._refresh()
        with self._lock:
            record = self._records[identifier]
            if record["kind"] != "document":
                raise ValueError("Evidence is available for ingested documents")
            document_id = record["metadata"]["document_id"]
        offset, limit = max(0, int(offset)), max(1, min(100, int(limit)))
        path = self._guard(self.home, "state/knowledge-base/knowledge.sqlite3")
        terms = re.findall(r"[\w-]+", str(q), re.UNICODE)[:20]
        with self._connect(path) as db:
            if terms:
                expression = " AND ".join('"' + term.replace('"', '""') + '"' for term in terms)
                relation = ("FROM chunk_search JOIN chunks c ON c.id=chunk_search.rowid "
                            "WHERE chunk_search MATCH ? AND c.document_id=?")
                args = (expression, document_id)
            else:
                relation = "FROM chunks c WHERE c.document_id=?"
                args = (document_id,)
            total = db.execute("SELECT count(*) " + relation, args).fetchone()[0]
            rows = [dict(row) for row in db.execute(
                "SELECT c.id,c.locator,c.method,c.text " + relation +
                " ORDER BY c.id LIMIT ? OFFSET ?", (*args, limit, offset))]
        return {"items": [{"id": r["id"], "locator": sanitize(r["locator"]),
                            "method": sanitize(r["method"]), "text": sanitize(r["text"])}
                           for r in rows], "total": total, "offset": offset, "limit": limit}

    def _similar_documents(self, document_id, limit=12):
        tags = self._knowledge_tags.get(document_id, set())
        scores, reasons, anchored = Counter(), defaultdict(list), set()
        for field, value in tags:
            if field == "issue" and value not in {"replacement"}:
                weight, anchor = 4, True
            elif field == "model" and re.search(r"\d", value) and len(value) >= 5:
                weight, anchor = 6, True
            elif field == "device_type":
                weight, anchor = 1, False
            else:
                continue
            for other in self._knowledge_terms.get((field, value), set()):
                if other == document_id:
                    continue
                scores[other] += weight
                reasons[other].append(field + ": " + value)
                if anchor:
                    anchored.add(other)
        ranked = sorted((other for other in anchored if other in self._knowledge_documents),
                        key=lambda other: (-scores[other], other))
        return [(self._knowledge_documents[other], reasons[other])
                for other in ranked[:limit]]

    def _links(self):
        pending = []
        source = {"id": "literal-links", "label": "Literal links in stored text", "path": "derived from allowlisted stores", "status": "active", "count": 0, "updated_at": _now()}
        for record in list(self._records.values()):
            for match in _URL_RE.finditer(record["body"]):
                url = safe_url(match.group(0))
                if url:
                    pending.append((record["id"], url))
        for origin, url in pending:
            identifier = self._id(source["id"], "urls", url)
            if identifier not in self._records:
                self._add(source, "urls", url, "link", urlsplit(url).hostname + urlsplit(url).path, url, domain=urlsplit(url).hostname, url=url)
            self._edge(origin, identifier, "contains literal URL", "extracted", "Exact URL extracted from the displayed stored text; not a semantic association")
        source["count"] = sum(i["kind"] == "link" for i in self._records.values())
        self._sources.append(source)

    def _filtered(self, q, kind):
        if kind and kind not in KINDS:
            raise ValueError("Unknown item kind")
        terms = str(q).casefold().split()[:20]
        evidence_matches = self._knowledge_matches(q) if terms else set()
        result = [r for r in self._records.values()
                  if (not kind or r["kind"] == kind)
                  and (all(t in (r["title"] + " " + r["body"] + " " + r["source"]["label"]).casefold()
                           for t in terms)
                       or (r["kind"] == "document"
                           and r["metadata"]["document_id"] in evidence_matches))]
        return sorted(result, key=lambda r: (r.get("updated_at") or r.get("created_at") or "", r["id"]), reverse=True)

    def overview(self):
        self._refresh()
        with self._lock:
            return copy.deepcopy({"updated_at": self._updated_at, "counts": {k: sum(r["kind"] == k for r in self._records.values()) for k in KINDS},
                                  "relationships": dict(Counter(e["type"] for e in self._edges)),
                                  "catalog_entities": dict(Counter(r["metadata"]["catalog_role"] for r in self._records.values() if r["metadata"].get("catalog_role"))),
                                  "sources": self._sources, "warnings": self._warnings, "read_only": True, "profile": "Lumos"})

    def items(self, q="", kind="", offset=0, limit=50):
        self._refresh()
        with self._lock:
            offset, limit = max(0, int(offset)), max(1, min(500, int(limit)))
            selected = self._filtered(q, kind)
            slim = [{k: r[k] for k in ("id", "title", "kind", "excerpt", "source", "created_at", "updated_at", "related_count", "skill_origin", "learned", "bundled") if k in r} for r in selected[offset:offset + limit]]
            return copy.deepcopy({"items": slim, "total": len(selected), "offset": offset, "limit": limit, "updated_at": self._updated_at})

    def item(self, identifier):
        self._refresh()
        with self._lock:
            record = self._records[identifier]
            related, links = [], []
            for edge in self._edges:
                if identifier not in (edge["source"], edge["target"]):
                    continue
                other = self._records[edge["target"] if edge["source"] == identifier else edge["source"]]
                related.append({"id": other["id"], "title": other["title"], "kind": other["kind"],
                                "catalog_role": other["metadata"].get("catalog_role", ""),
                                **{k: edge[k] for k in ("relationship", "type", "evidence")}})
                if other["kind"] == "link":
                    links.append({"url": other["metadata"]["url"], "domain": other["metadata"]["domain"]})
            if record["kind"] == "document":
                document_id = record["metadata"]["document_id"]
                path = self._guard(self.home, "state/knowledge-base/knowledge.sqlite3")
                with self._connect(path) as db:
                    row = db.execute("SELECT warnings,error FROM documents WHERE id=?",
                                     (document_id,)).fetchone()
                if row:
                    record = copy.deepcopy(record)
                    try:
                        record["metadata"]["coverage_warnings"] = [
                            sanitize(w) for w in json.loads(row["warnings"] or "[]")]
                    except (ValueError, TypeError):
                        record["metadata"]["coverage_warnings"] = [
                            "Saved coverage warnings could not be decoded"]
                    record["metadata"]["error"] = sanitize(row["error"])
                for other_id, reasons in self._similar_documents(document_id):
                    other = self._records[other_id]
                    related.append({"id": other_id, "title": other["title"],
                                    "kind": "document", "relationship":
                                    "Possible comparison: " + ", ".join(reasons[:4]),
                                    "type": "indexed",
                                    "evidence": "Shared indexed terms suggest a comparison; "
                                    "confirm each claim against the cited source pages."})
            related_priority = {"concept": 1, "product_family": 2, "manufacturer": 2, "product": 3}
            related.sort(key=lambda item: (0 if item["type"] == "reasoned" else related_priority.get(item.get("catalog_role"), 4), item["title"].casefold(), item["id"]))
            return copy.deepcopy({"item": record, "related": related, "links": links, "updated_at": self._updated_at})

    def graph(self, q="", kind="", limit=400, focus=""):
        self._refresh()
        with self._lock:
            limit = max(1, min(1200, int(limit)))
            selected = [r for r in self._filtered(q, kind) if not r["metadata"].get("withheld")]
            if focus:
                if focus not in self._records or self._records[focus]["metadata"].get("withheld"):
                    raise KeyError(focus)
                allowed = {r["id"] for r in selected}
                neighbors = defaultdict(set)
                for edge in self._edges:
                    neighbors[edge["source"]].add(edge["target"])
                    neighbors[edge["target"]].add(edge["source"])
                direct = neighbors[focus] & allowed
                surrounding = {identifier for node in direct for identifier in neighbors[node]} & allowed
                neighborhood = direct | surrounding | {focus}
                selected = [self._records[identifier] for identifier in neighborhood
                            if not self._records[identifier]["metadata"].get("withheld")]
            else:
                direct = set()
            priority = {"memory": 0, "entity": 1, "document": 2, "note": 3,
                        "skill": 4, "conversation": 5, "link": 6}
            reasoned = {e[side] for e in self._edges if e["type"] == "reasoned" for side in ("source", "target")}
            def order(record):
                return (record["id"] not in reasoned, record["historical"], -record["related_count"], record["id"])
            # Mix product references and source documents instead of filling the
            # entire view with one high-volume kind. A focus is always retained.
            groups = defaultdict(list)
            for record in sorted(selected, key=order):
                role = record["metadata"].get("catalog_role", record["kind"])
                groups[role].append(record)
            hub_roles = ("manufacturer", "product_family", "concept", "topic", "device_type")
            preferred = [record for role in hub_roles for record in groups.pop(role, [])]
            preferred.sort(key=lambda r: (r["id"] != focus, r["id"] not in direct, order(r)))
            mixed = sorted(((rank, priority.get(record["kind"], 3), order(record), record)
                            for group in groups.values() for rank, record in enumerate(group)), key=lambda item: item[:3])
            chosen = preferred[:max(1, limit // 4)] + [item[3] for item in mixed]
            # Prioritize direct neighbors in focused views, preserving a mix of
            # products/manuals and a few second-hop context nodes.
            if focus:
                chosen.sort(key=lambda r: (r["id"] != focus, r["id"] not in direct))
                if not any(r["id"] == focus for r in chosen):
                    chosen.insert(0, self._records[focus])
            ids = [r["id"] for r in chosen[:limit]]
            nodes = [{"id": i, "label": self._records[i]["title"], "kind": self._records[i]["kind"],
                      "catalog_role": self._records[i]["metadata"].get("catalog_role", "")} for i in ids]
            edges = [e for e in self._edges if e["source"] in ids and e["target"] in ids]
            return copy.deepcopy({"nodes": nodes, "edges": edges, "total_nodes": len(selected),
                                  "total_connections": len(self._edges), "focus": focus,
                                  "focus_label": self._records[focus]["title"] if focus else "",
                                  "truncated": len(selected) > len(ids), "updated_at": self._updated_at})

    def export(self, q="", kind=""):
        self._refresh()
        with self._lock:
            selected = self._filtered(q, kind)
            ids = {r["id"] for r in selected}
            return copy.deepcopy({"items": selected, "edges": [e for e in self._edges if e["source"] in ids and e["target"] in ids], "sources": self._sources, "warnings": self._warnings, "updated_at": self._updated_at, "read_only": True})
