"""Keyless web search for Lumos on Nimbus (what Hermes used: web.search_backend ddgs).

A minimal MCP stdio server (newline-delimited JSON-RPC 2.0) with one read-only tool,
``web_search``. Run it with the Hermes runtime venv, which has the ``ddgs`` package.
No API keys, no state, no writes.
"""
from __future__ import annotations

import json
import sys

PROTOCOL = "2025-06-18"
TOOL = {
    "name": "web_search",
    "description": "Search the public web (DuckDuckGo and other keyless engines via ddgs). Returns titles, URLs and snippets. Read-only.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search terms"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 8},
        },
        "required": ["query"],
        "additionalProperties": False,
    },
    "annotations": {"readOnlyHint": True, "openWorldHint": True},
}


# ddgs "auto" often returns nothing for a query that works a second later (live 2026-11-25:
# "Node.js 26 release date" failed twice, then returned 5). Fall back across keyless engines.
BACKENDS = ("auto", "brave", "mojeek", "yahoo", "duckduckgo", "startpage")


def search(query: str, limit: int) -> list[dict]:
    from ddgs import DDGS
    errors = []
    for backend in BACKENDS:
        try:
            results = DDGS().text(query, max_results=limit, backend=backend) or []
        except Exception as exc:  # "No results found" is raised as an exception
            errors.append(f"{backend}: {exc}")
            continue
        hits = [{"title": r.get("title", ""), "url": r.get("href") or r.get("url", ""), "snippet": r.get("body", "")} for r in results]
        if hits:
            return hits
        errors.append(f"{backend}: no results")
    raise RuntimeError("No results from any engine (" + "; ".join(errors)[:600] + ")")


def handle(msg: dict) -> dict | None:
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        return None  # notification
    if method == "initialize":
        result = {"protocolVersion": msg.get("params", {}).get("protocolVersion", PROTOCOL),
                  "capabilities": {"tools": {}}, "serverInfo": {"name": "lumos-web-search", "version": "1.0.0"}}
    elif method == "tools/list":
        result = {"tools": [TOOL]}
    elif method == "tools/call":
        params = msg.get("params") or {}
        args = params.get("arguments") or {}
        if params.get("name") != "web_search" or not isinstance(args.get("query"), str) or not args["query"].strip():
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "web_search needs a query"}}
        try:
            limit = max(1, min(20, int(args.get("limit", 8))))
            hits = search(args["query"].strip()[:400], limit)
            result = {"content": [{"type": "text", "text": json.dumps({"query": args["query"], "results": hits}, ensure_ascii=False)}],
                      "structuredContent": {"results": hits}, "isError": False}
        except Exception as exc:  # network or engine failure: report, never invent results
            result = {"content": [{"type": "text", "text": f"Search failed: {type(exc).__name__}: {exc}"}], "isError": True}
    elif method == "ping":
        result = {}
    else:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Unknown method {method}"}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def main() -> None:
    # MCP stdio is UTF-8. The Windows default (cp1252) turned "—" into "�" and crashed the
    # server on characters outside cp1252 (live 2026-11-25: U+2011 in a search snippet).
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    stdout = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            reply = handle(json.loads(line))
        except Exception as exc:
            reply = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}}
        if reply is not None:
            stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            stdout.flush()


if __name__ == "__main__":
    main()
