from __future__ import annotations

import json
import re
import sqlite3
import time
from pathlib import Path

SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS documents (
 id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, sha256 TEXT NOT NULL,
 kind TEXT NOT NULL, status TEXT NOT NULL, warnings TEXT NOT NULL DEFAULT '[]',
 error TEXT, updated REAL NOT NULL);
CREATE TABLE IF NOT EXISTS chunks (
 id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 locator TEXT NOT NULL, method TEXT NOT NULL, text TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search USING fts5(text,content='chunks',content_rowid='id');
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
 INSERT INTO chunk_search(rowid,text) VALUES(new.id,new.text); END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
 INSERT INTO chunk_search(chunk_search,rowid,text) VALUES('delete',old.id,old.text); END;
CREATE TABLE IF NOT EXISTS tags (
 document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 field TEXT NOT NULL, value TEXT NOT NULL, evidence TEXT NOT NULL, origin TEXT NOT NULL,
 PRIMARY KEY(document_id,field,value));
CREATE TABLE IF NOT EXISTS assets (
 document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 path TEXT NOT NULL, locator TEXT NOT NULL, kind TEXT NOT NULL);
"""


def infer_tags(text):
    """Conservative suggestions with their literal evidence, never authoritative facts."""
    rules = {
        "brand": [r"\bHP\b", r"\bLenovo\b", r"\bDell\b", r"\bBrother\b", r"\bEpson\b"],
        "device_type": [r"\b(?:printer|printers)\b", r"\b(?:laptop|laptops)\b", r"\b(?:desktop|desktops)\b", r"\b(?:server|servers)\b", r"\bRPOS\b"],
        "model": [r"\b(?:PageWide|LaserJet|ThinkPad|ProLiant|EliteBook|ThinkCentre)\s+[A-Z0-9][\w.-]*", r"\bModel\s*[:=]\s*([^\n,;]{1,80})"],
        "issue": [r"\bboot failure\b", r"\bpaper jam\b", r"\bsystem board\b", r"\bpower supply\b", r"\breplacement\b", r"\bnetwork connectivity\b"],
    }
    result = []
    for field, patterns in rules.items():
        for pattern in patterns:
            for m in re.finditer(pattern, text, re.I):
                value = (m.group(1) if m.lastindex else m.group()).strip()
                result.append((field, value, text[max(0, m.start()-50):m.end()+50], "heuristic"))
    return result


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)

    def close(self):
        self.db.close()

    def existing(self, path):
        return self.db.execute("SELECT * FROM documents WHERE path=?", (str(path),)).fetchone()

    def replace(self, path, sha, kind, segments, assets=(), warnings=(), metadata=None):
        status = "partial" if warnings else "complete"
        if not segments:
            status = "partial"
            warnings = [*warnings, "No extractable text; inspect source/assets before answering"]
        with self.db:
            self.db.execute("""INSERT INTO documents(path,sha256,kind,status,warnings,updated)
                VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256,
                kind=excluded.kind,status=excluded.status,warnings=excluded.warnings,error=NULL,updated=excluded.updated""",
                (str(path), sha, kind, status, json.dumps(list(warnings)), time.time()))
            doc_id = self.existing(path)["id"]
            for table in ("chunks", "tags", "assets"):
                self.db.execute(f"DELETE FROM {table} WHERE document_id=?", (doc_id,))
            for seg in segments:
                # Keep page/time provenance on every bounded search chunk.
                for offset in range(0, len(seg["text"]), 3500):
                    text = seg["text"][offset:offset+3500]
                    if text.strip():
                        self.db.execute("INSERT INTO chunks(document_id,locator,method,text) VALUES(?,?,?,?)",
                                        (doc_id, seg["locator"], seg["method"], text))
            tags = infer_tags(str(path) + "\n" + "\n".join(s["text"] for s in segments))
            for field, values in (metadata or {}).items():
                if field not in {"brand", "device_type", "model", "issue"}:
                    raise ValueError(f"Unknown metadata field: {field}")
                for value in ([values] if isinstance(values, str) else values):
                    tags.append((field, str(value), "Operator supplied metadata", "operator"))
            self.db.executemany("INSERT OR IGNORE INTO tags VALUES(?,?,?,?,?)", [(doc_id, *t) for t in tags])
            self.db.executemany("INSERT INTO assets VALUES(?,?,?,?)", [(doc_id, a["path"], a["locator"], a["kind"]) for a in assets])
        return {"id": doc_id, "path": str(path), "status": status, "chunks": self.db.execute("SELECT count(*) FROM chunks WHERE document_id=?", (doc_id,)).fetchone()[0], "assets": len(assets), "warnings": list(warnings)}

    def failure(self, path, sha, error, status="failed"):
        with self.db:
            self.db.execute("""INSERT INTO documents(path,sha256,kind,status,error,updated) VALUES(?,?,?,?,?,?)
              ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256,status=excluded.status,error=excluded.error,updated=excluded.updated""",
              (str(path), sha, Path(path).suffix, status, str(error), time.time()))
        return {"path": str(path), "status": status, "error": str(error)}

    def search(self, query, filters=None, limit=10):
        terms = re.findall(r"[\w-]+", query, re.UNICODE)
        if not terms:
            return []
        match = " OR ".join('"' + t.replace('"', '""') + '"' for t in terms)
        sql = """SELECT c.id chunk_id,c.document_id,d.path,d.status,d.warnings,c.locator,c.method,c.text,
                 bm25(chunk_search) score FROM chunk_search JOIN chunks c ON c.id=chunk_search.rowid
                 JOIN documents d ON d.id=c.document_id WHERE chunk_search MATCH ? AND d.status IN ('complete','partial')"""
        args = [match]
        for field, value in (filters or {}).items():
            if field not in {"brand", "model", "device_type", "issue"}:
                raise ValueError("Unknown filter")
            sql += " AND EXISTS(SELECT 1 FROM tags t WHERE t.document_id=d.id AND t.field=? AND lower(t.value)=lower(?))"
            args += [field, value]
        args.append(max(1, min(int(limit), 100)))
        return [dict(r) for r in self.db.execute(sql + " ORDER BY score LIMIT ?", args)]

    def report(self):
        return [dict(r) for r in self.db.execute("SELECT id,path,kind,status,warnings,error,updated FROM documents ORDER BY id")]

    def export(self, document_id):
        row = self.db.execute("SELECT * FROM documents WHERE id=?", (document_id,)).fetchone()
        if row is None:
            raise ValueError("Unknown document")
        d = dict(row)
        d["warnings"] = json.loads(d["warnings"])
        for table in ("chunks", "tags", "assets"):
            d[table] = [dict(r) for r in self.db.execute(f"SELECT * FROM {table} WHERE document_id=?", (document_id,))]
        return d
