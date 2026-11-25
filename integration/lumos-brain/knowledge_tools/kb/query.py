"""Read-only, source-cited queries over Lumos's ingested evidence.

The knowledge index is a document corpus, not conversational memory. These
tools keep partial-coverage warnings and page/time locators attached so an
agent can compare devices without silently promoting guesses to OEM facts.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path
import re
import sqlite3

from .common import STATE

DATABASE = STATE / "knowledge.sqlite3"
FIELDS = {"brand", "model", "device_type", "issue"}


@contextmanager
def connect(path=DATABASE):
    path = Path(path).resolve()
    if not path.is_file():
        raise FileNotFoundError(str(path))
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    try:
        yield db
    finally:
        db.close()


def publication_provenance(db, document_id, sha256):
    """Match only the current real KB identity and content hash; never title/path guesses."""
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nimbus_publications'").fetchone():
        return {}
    row = db.execute("SELECT manifest,receipt FROM nimbus_publications WHERE kb_document_id=? ORDER BY revision DESC LIMIT 1", (document_id,)).fetchone()
    if not row:
        return {}
    manifest, receipt = json.loads(row[0]), json.loads(row[1])
    if manifest["sha256"] != sha256 or receipt["sha256"] != sha256:
        return {}
    return {"publication": dict(manifest, archive_path=receipt["archive_path"],
                                 manifest_path=receipt["manifest_path"],
                                 kb_document_id=document_id)}

def expression(query):
    terms = re.findall(r"[\w-]+", str(query), re.UNICODE)[:20]
    if not terms:
        raise ValueError("Supply a technical term, model, part, or issue")
    return " AND ".join('"' + term.replace('"', '""') + '"' for term in terms)


def _warnings(row):
    try:
        value = json.loads(row["warnings"] or "[]")
        return value if isinstance(value, list) else ["Coverage warnings are malformed"]
    except (ValueError, TypeError):
        return ["Coverage warnings are malformed"]


def search_evidence(query, filters=None, limit=12, path=DATABASE):
    filters = filters or {}
    if any(field not in FIELDS for field in filters):
        raise ValueError("Unknown metadata filter")
    limit = max(1, min(int(limit), 30))
    sql = """SELECT c.id chunk_id,c.document_id,d.path,d.sha256,d.status,d.warnings,
                    c.locator,c.method,c.text,bm25(chunk_search) score
             FROM chunk_search JOIN chunks c ON c.id=chunk_search.rowid
             JOIN documents d ON d.id=c.document_id
             WHERE chunk_search MATCH ? AND d.status IN ('complete','partial')"""
    args = [expression(query)]
    for field, value in filters.items():
        if value:
            sql += (" AND EXISTS(SELECT 1 FROM tags t WHERE t.document_id=d.id "
                    "AND t.field=? AND lower(t.value)=lower(?))")
            args.extend((field, str(value)))
    sql += " ORDER BY score LIMIT ?"
    args.append(limit)
    with connect(path) as db:
        rows = [dict(r) for r in db.execute(sql, args)]
        for row in rows:
            row.update(publication_provenance(db, row["document_id"], row["sha256"]))
    for row in rows:
        row["warnings"] = _warnings(row)
    return {"query": query, "results": rows, "count": len(rows),
            "interpretation": "Source excerpts are evidence, not validated cross-device procedures."}


def document_evidence(document_id, offset=0, limit=20, query="", path=DATABASE):
    document_id, offset = int(document_id), max(0, int(offset))
    limit = max(1, min(int(limit), 50))
    with connect(path) as db:
        row = db.execute("SELECT * FROM documents WHERE id=?", (document_id,)).fetchone()
        if row is None:
            raise ValueError("Unknown indexed document")
        document = dict(row)
        document.update(publication_provenance(db, document_id, row["sha256"]))
        document["warnings"] = _warnings(row)
        document["tags"] = [dict(r) for r in db.execute(
            "SELECT field,value,evidence,origin FROM tags WHERE document_id=? "
            "ORDER BY field,value", (document_id,))]
        if query:
            relation = ("FROM chunk_search JOIN chunks c ON c.id=chunk_search.rowid "
                        "WHERE chunk_search MATCH ? AND c.document_id=?")
            args = (expression(query), document_id)
        else:
            relation = "FROM chunks c WHERE c.document_id=?"
            args = (document_id,)
        total = db.execute("SELECT count(*) " + relation, args).fetchone()[0]
        document["evidence"] = [dict(r) for r in db.execute(
            "SELECT c.id,c.locator,c.method,c.text " + relation +
            " ORDER BY c.id LIMIT ? OFFSET ?", (*args, limit, offset))]
        document["evidence_total"] = total
        document["offset"] = offset
        document["limit"] = limit
    return document


def related_documents(document_id, limit=12, path=DATABASE):
    document_id = int(document_id)
    limit = max(1, min(int(limit), 30))
    with connect(path) as db:
        source = db.execute("SELECT id,path,status FROM documents WHERE id=?",
                            (document_id,)).fetchone()
        if source is None:
            raise ValueError("Unknown indexed document")
        source_tags = {(r["field"], r["value"].strip().casefold()) for r in db.execute(
            "SELECT field,value FROM tags WHERE document_id=?", (document_id,))}
        scores, reasons, anchored = {}, {}, set()
        for field, value in source_tags:
            if field == "issue" and value != "replacement":
                weight, anchor = 4, True
            elif field == "model" and re.search(r"\d", value) and len(value) >= 5:
                weight, anchor = 6, True
            elif field == "device_type":
                weight, anchor = 1, False
            else:
                continue
            for row in db.execute(
                "SELECT DISTINCT document_id FROM tags WHERE field=? AND lower(value)=? "
                "AND document_id<>?", (field, value, document_id)):
                other = row["document_id"]
                scores[other] = scores.get(other, 0) + weight
                reasons.setdefault(other, []).append(field + ": " + value)
                if anchor:
                    anchored.add(other)
        ranked = sorted(anchored, key=lambda key: (-scores[key], key))[:limit]
        results = []
        for other in ranked:
            row = db.execute("SELECT id,path,status,warnings FROM documents WHERE id=?",
                             (other,)).fetchone()
            if row:
                results.append({"document_id": other, "path": row["path"],
                                "status": row["status"], "warnings": _warnings(row),
                                "shared_indexed_terms": reasons[other],
                                "score": scores[other]})
    return {"document_id": document_id, "related": results,
            "caution": "Shared heuristic tags are comparison leads, not proof of compatible parts or procedures."}


def compare_documents(left_id, right_id, topic, limit=8, path=DATABASE):
    if int(left_id) == int(right_id):
        raise ValueError("Choose two distinct indexed documents")
    limit = max(1, min(int(limit), 20))
    left = document_evidence(left_id, limit=limit, query=topic, path=path)
    right = document_evidence(right_id, limit=limit, query=topic, path=path)
    left_tags = {(t["field"], t["value"].casefold()) for t in left["tags"]}
    right_tags = {(t["field"], t["value"].casefold()) for t in right["tags"]}
    return {"topic": topic, "left": left, "right": right,
            "shared_indexed_terms": [{"field": field, "value": value}
                                     for field, value in sorted(left_tags & right_tags)],
            "interpretation": "Compare the cited locators and original visuals before applying a procedure to another model. Partial warnings remain material."}
