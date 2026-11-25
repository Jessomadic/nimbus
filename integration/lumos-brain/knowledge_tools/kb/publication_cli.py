"""Supported publication CLI; no HTTP/write-MCP surface."""
import argparse
import json
from pathlib import Path
from .publication import PublicationStore, local, publish

def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--db", required=True)
    p.add_argument("--input-root", required=True)
    p.add_argument("--archive-root", required=True)
    sub = p.add_subparsers(dest="action", required=True)
    q = sub.add_parser("publish-nimbus")
    q.add_argument("--request", required=True)
    q = sub.add_parser("publication-status")
    q.add_argument("--request-id", required=True)
    a = p.parse_args(argv)
    s = PublicationStore(a.db)
    try:
        if a.action == "publication-status":
            return s.status(a.request_id)
        path = local(a.request, a.input_root)
        if path.stat().st_size > 100000:
            raise ValueError("Manifest too large")
        return publish(s, json.loads(path.read_text(encoding="utf-8")), a.input_root, a.archive_root)
    finally:
        s.close()

def entry(argv=None):
    try:
        print(json.dumps(main(argv), ensure_ascii=True))
    except Exception as exc:
        print(json.dumps({"status": "failed_precommit_or_reconcile", "error": str(exc)}))
        raise SystemExit(1)

if __name__ == '__main__':
    entry()
