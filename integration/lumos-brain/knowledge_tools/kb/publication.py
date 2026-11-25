"""Explicit Nimbus Markdown publication. Only this Store owns publication SQL."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import uuid
from datetime import datetime, timezone
from .store import Store

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

def digest(data):
    return hashlib.sha256(data).hexdigest()

def local(path, root):
    p = Path(path).absolute()
    if str(p).startswith(("\\\\", "//")) or ".." in p.parts:
        raise ValueError("Local non-traversing path required")
    for part in (p, *p.parents):
        if part.is_symlink() or getattr(part, "is_junction", lambda: False)():
            raise ValueError("Links/junctions forbidden")
    p = p.resolve()
    if not p.is_relative_to(Path(root).resolve()):
        raise ValueError("Path outside allowlisted root")
    return p

def validate(m):
    required = {"request_id", "source_namespace", "source_document_id", "source_revision",
                "expected_published_revision", "sha256", "markdown_path", "title", "source_uri",
                "author_label", "published_by", "published_at", "citations"}
    if set(m) != required:
        raise ValueError("Manifest v1 fields required exactly")
    for key in ("request_id", "source_document_id"):
        if str(uuid.UUID(m[key])) != m[key]:
            raise ValueError("Canonical UUID required")
    installation = m["source_namespace"].removeprefix("nimbus:")
    if m["source_namespace"] != "nimbus:" + str(uuid.UUID(installation)):
        raise ValueError("Invalid namespace")
    rev, previous = m["source_revision"], m["expected_published_revision"]
    if type(rev) is not int or rev < 1 or (previous is not None and (type(previous) is not int or previous < 1)):
        raise ValueError("Invalid revision")
    if m["source_uri"] != f'nimbus://{installation}/{m["source_document_id"]}?rev={rev}':
        raise ValueError("Invalid source URI")
    if not re.fullmatch("[0-9a-f]{64}", m["sha256"]):
        raise ValueError("Invalid SHA256")
    for key, bound in (("title", 500), ("author_label", 200), ("published_by", 200), ("published_at", 80)):
        if not isinstance(m[key], str) or not 1 <= len(m[key]) <= bound:
            raise ValueError("Invalid " + key)
    if datetime.fromisoformat(m["published_at"].replace("Z", "+00:00")).tzinfo is None:
        raise ValueError("Timestamp must include timezone")
    if not isinstance(m["citations"], list) or len(m["citations"]) > 20:
        raise ValueError("Invalid citations")
    for c in m["citations"]:
        if set(c) - {"record_id", "fingerprint", "quote", "locator"} or not {"record_id", "fingerprint", "quote"} <= set(c):
            raise ValueError("Invalid citation fields")
        if not isinstance(c["record_id"], str) or not 1 <= len(c["record_id"]) <= 100 or not re.fullmatch("[0-9a-f]{64}", c["fingerprint"]):
            raise ValueError("Invalid citation identity")
        if not isinstance(c["quote"], str) or not 12 <= len(c["quote"]) <= 800 or len(c.get("locator", "")) > 200:
            raise ValueError("Invalid citation evidence")

class PublicationStore(Store):
    def __init__(self, path):
        super().__init__(path)
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS nimbus_publications(
          request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
          namespace TEXT NOT NULL, source_document_id TEXT NOT NULL, revision INTEGER NOT NULL,
          kb_document_id INTEGER NOT NULL REFERENCES documents(id),
          manifest TEXT NOT NULL, receipt TEXT NOT NULL,
          UNIQUE(namespace,source_document_id,revision));
        """)
    def status(self, request_id):
        row = self.db.execute("SELECT receipt FROM nimbus_publications WHERE request_id=?", (request_id,)).fetchone()
        return json.loads(row[0]) if row else {"request_id": request_id, "status": "not_committed",
                                               "note": "Does not prove no process is active"}
    def commit_publication(self, m, payload_hash, archive, manifest, segments):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            old = self.db.execute("SELECT * FROM nimbus_publications WHERE request_id=?", (m["request_id"],)).fetchone()
            if old:
                if old["payload_hash"] != payload_hash:
                    raise ValueError("409 request payload conflict")
                result = json.loads(old["receipt"])
                self.db.rollback()
                return result
            key = (m["source_namespace"], m["source_document_id"])
            current = self.db.execute("SELECT * FROM nimbus_publications WHERE namespace=? AND source_document_id=? ORDER BY revision DESC LIMIT 1", key).fetchone()
            previous = current["revision"] if current else None
            if previous != m["expected_published_revision"] or (previous is not None and m["source_revision"] <= previous):
                raise ValueError("409 published revision conflict")
            logical = f'nimbus://{key[0][7:]}/{key[1]}'
            indexed = self.replace(logical, m["sha256"], ".md", segments)
            receipt = dict(request_id=m["request_id"], status="committed", namespace=key[0],
                           source_document_id=key[1], revision=m["source_revision"], sha256=m["sha256"],
                           kb_document_id=indexed["id"], archive_path=str(archive), manifest_path=str(manifest),
                           previous_revision=previous, committed_at=datetime.now(timezone.utc).isoformat(), warnings=[])
            self.db.execute("INSERT INTO nimbus_publications VALUES(?,?,?,?,?,?,?,?)",
                (m["request_id"], payload_hash, *key, m["source_revision"], indexed["id"],
                 canonical(m).decode("utf-8"), canonical(receipt).decode("utf-8")))
            self.db.commit()
            return receipt
        except BaseException:
            self.db.rollback()
            raise

def immutable(path, data):
    # Publish only complete, fsynced bytes. A crash can leave an unreferenced
    # temp file, never a partial canonical archive. Hard-link is create-if-absent,
    # unlike replace(), so concurrent writers cannot overwrite immutable bytes.
    import tempfile
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            if path.read_bytes() != data:
                raise ValueError("Immutable archive conflict")
    finally:
        Path(temporary).unlink(missing_ok=True)

def publish(store, manifest, input_root, archive_root, extractor=None):
    validate(manifest)
    m = manifest
    payload_hash = digest(canonical(m))
    # Reconcile committed requests before accessing inputs or extracting.
    old = store.db.execute("SELECT payload_hash,receipt FROM nimbus_publications WHERE request_id=?", (m["request_id"],)).fetchone()
    if old:
        if old[0] != payload_hash:
            raise ValueError("409 request payload conflict")
        return json.loads(old[1])
    root = local(archive_root, archive_root)
    root.mkdir(parents=True, exist_ok=True)
    folder = root / m["request_id"]
    folder.mkdir(exist_ok=True)
    folder = local(folder, root)
    archive, saved = local(folder / "source.md", root), local(folder / "manifest.json", root)
    # Immutable staged manifest is the request/payload recovery boundary.
    if saved.exists() and saved.read_bytes() != canonical(m):
        raise ValueError("409 archived request payload conflict")
    if archive.exists():
        data = archive.read_bytes()
    else:
        source = local(m["markdown_path"], input_root)
        if source.suffix.lower() != ".md" or source.stat().st_size > 1000000:
            raise ValueError("Only bounded Markdown accepted")
        data = source.read_bytes()
    if len(data) > 1000000 or digest(data) != m["sha256"]:
        raise ValueError("Hash/size mismatch")
    text = data.decode("utf-8")
    if not text.strip():
        raise ValueError("No extractable text")
    immutable(archive, data)
    immutable(saved, canonical(m))
    extracted = local(folder / "extraction.json", root)
    if extracted.exists():
        value = json.loads(extracted.read_text(encoding="utf-8"))
        if set(value) != {"segments", "warnings"} or value["warnings"]:
            raise ValueError("Invalid archived extraction")
        segments = value["segments"]
        if not segments or not any(s["text"].strip() for s in segments):
            raise ValueError("Invalid archived extraction")
        return store.commit_publication(m, payload_hash, archive, saved, segments)
    if extractor:
        segments, assets, warnings = extractor(archive, folder / "extraction")
    else:
        # Same native Markdown line segmentation as extract.extract, with strict UTF-8.
        lines = text.splitlines(keepends=True)
        segments = [dict(text="".join(lines[i:i+80]), locator=f"lines:{i+1}-{min(i+80,len(lines))}", method="native") for i in range(0,len(lines),80)]
        assets, warnings = [], []
    if warnings or assets or not segments or not any(s["text"].strip() for s in segments):
        raise ValueError("Partial extraction; previous publication preserved")
    immutable(local(folder / "extraction.json", root), canonical({"segments": segments, "warnings": []}))
    return store.commit_publication(m, payload_hash, archive, saved, segments)
