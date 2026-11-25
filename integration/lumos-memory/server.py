"""Lumos memory MCP server (stdio) for Nimbus.

Modes:
  server.py --home <gen dir> --render <bot MEMORY.md>            MCP over stdio (default)
  server.py --home <gen dir> --prefetch "<query>"                top-5 facts as JSON, within 5 s
  server.py --home <gen dir> --extract  < messages.json          auto-extract facts, JSON summary
  server.py --home <gen dir> --render <path> --render-now        write the render file and exit

Tools: memory, fact_store, fact_feedback, session_search (see README.md).
stdout carries only protocol / JSON output; diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path

_T0 = time.monotonic()
sys.path.insert(0, str(Path(__file__).resolve().parent))

PREFETCH_BUDGET_S = 5.0
SERVER_NAME, SERVER_VERSION = "lumos-memory", "1.0.0"


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--home", required=True, help="lumos-home generation folder (or lumos-home root with current.json)")
    p.add_argument("--render", help="Nimbus bot MEMORY.md to re-render after memory writes")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--prefetch", metavar="QUERY", help="print top-5 relevant facts as JSON and exit")
    mode.add_argument("--extract", action="store_true", help="read JSON messages on stdin, auto-extract facts, exit")
    mode.add_argument("--render-now", action="store_true", help="write the --render file and exit")
    p.add_argument("--transport", choices=["mcp", "jsonrpc"], default="mcp",
                   help="mcp = the mcp package's stdio server (default); jsonrpc = built-in minimal fallback")
    p.add_argument("--memory-char-limit", type=int, default=2200)
    p.add_argument("--user-char-limit", type=int, default=1375)
    p.add_argument("--default-trust", type=float, default=0.5)
    p.add_argument("--min-trust", type=float, default=0.3)
    p.add_argument("--hrr-dim", type=int, default=1024)
    p.add_argument("--hrr-weight", type=float, default=0.3)
    p.add_argument("--temporal-decay-half-life", type=int, default=0)
    p.add_argument("--max-extract-messages", type=int, default=500)
    p.add_argument("--max-extract-facts", type=int, default=50)
    p.add_argument("--extract-budget-s", type=float, default=10.0)
    return p


def _open(args, *, facts=True):
    from lumos_memory import LumosMemory
    return LumosMemory(args.home, args.render, memory_char_limit=args.memory_char_limit,
                       user_char_limit=args.user_char_limit, default_trust=args.default_trust,
                       min_trust=args.min_trust, hrr_dim=args.hrr_dim, hrr_weight=args.hrr_weight,
                       temporal_decay_half_life=args.temporal_decay_half_life, facts=facts)


def _emit(obj) -> None:
    # UTF-8 bytes straight to the buffer: Windows' default console/pipe encoding (cp1252)
    # cannot encode '§', '→' or emoji, and text mode would also turn '\n' into '\r\n'.
    sys.stdout.flush()
    sys.stdout.buffer.write((json.dumps(obj, ensure_ascii=False, default=str) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


# ---------------------------------------------------------------------------
# CLI modes
# ---------------------------------------------------------------------------


def run_prefetch(args) -> int:
    out = {"query": args.prefetch, "facts": []}
    box = {}

    def work():
        try:
            from lumos_memory import resolve_home
            if not (resolve_home(args.home) / "memory_store.db").is_file():
                box["result"] = {**out, "note": "no memory_store.db in home"}
                return
            lm = _open(args)
            try:
                box["result"] = {**out, "facts": lm.facts.prefetch(args.prefetch, limit=5)}
            finally:
                lm.close()
        except Exception as e:  # best-effort: never break the host's run
            box["result"] = {**out, "error": str(e)}

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(max(0.1, PREFETCH_BUDGET_S - (time.monotonic() - _T0) - 0.25))
    if t.is_alive():
        _emit({**out, "timed_out": True})
        sys.stdout.flush()
        os._exit(0)
    _emit(box.get("result", out))
    return 0


def run_extract(args) -> int:
    summary = {"extracted": 0}
    try:
        raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            _emit({**summary, "error": "input over 8 MiB; nothing extracted"})
            return 0
        data = json.loads(raw.decode("utf-8-sig") or "[]")
        messages = data.get("messages", []) if isinstance(data, dict) else data
        if not isinstance(messages, list):
            _emit({**summary, "error": "expected a JSON list of messages or {\"messages\": [...]}"})
            return 0
        lm = _open(args)
        try:
            _emit(lm.facts.auto_extract(messages, max_messages=args.max_extract_messages,
                                        max_facts=args.max_extract_facts, deadline_s=args.extract_budget_s))
        finally:
            lm.close()
    except Exception as e:  # best-effort
        _emit({**summary, "error": str(e)})
    return 0


def run_render_now(args) -> int:
    if not args.render:
        _emit({"success": False, "error": "--render-now needs --render"})
        return 2
    lm = _open(args, facts=False)
    try:
        _emit({"success": True, "rendered": lm.render()})
    finally:
        lm.close()
    return 0


# ---------------------------------------------------------------------------
# MCP server
# ---------------------------------------------------------------------------


def _startup_render(lm) -> None:
    try:
        lm.render()
    except Exception as e:
        logging.getLogger("lumos_memory").warning("initial render failed: %s", e)


def serve_mcp(lm) -> int:
    import anyio
    from mcp import types
    from mcp.server.lowlevel import Server
    from mcp.server.stdio import stdio_server

    server = Server(SERVER_NAME, version=SERVER_VERSION)

    @server.list_tools()
    async def list_tools():
        return [types.Tool(name=s["name"], description=s["description"], inputSchema=s["parameters"])
                for s in lm.TOOLS.values()]

    @server.call_tool()
    async def call_tool(name, arguments):
        text = await anyio.to_thread.run_sync(lm.call, name, arguments or {})
        return [types.TextContent(type="text", text=text)]

    async def main():
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())

    anyio.run(main)
    return 0


def serve_jsonrpc(lm) -> int:
    """Minimal newline-delimited JSON-RPC 2.0 MCP server (initialize, tools/list, tools/call, ping)."""
    stdin = sys.stdin.buffer
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            _emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
            continue
        if not isinstance(msg, dict) or "id" not in msg:
            continue  # notification (e.g. notifications/initialized)
        mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
        if method == "initialize":
            result = {"protocolVersion": params.get("protocolVersion") or "2025-06-18",
                      "capabilities": {"tools": {"listChanged": False}},
                      "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": [{"name": s["name"], "description": s["description"], "inputSchema": s["parameters"]}
                                for s in lm.TOOLS.values()]}
        elif method == "tools/call":
            name = params.get("name")
            if name not in lm.TOOLS:
                result = {"content": [{"type": "text", "text": f"Unknown tool: {name}"}], "isError": True}
            else:
                try:
                    text = lm.call(name, params.get("arguments") or {})
                    result = {"content": [{"type": "text", "text": text}], "isError": False}
                except Exception as e:
                    result = {"content": [{"type": "text", "text": str(e)}], "isError": True}
        else:
            _emit({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {method}"}})
            continue
        _emit({"jsonrpc": "2.0", "id": mid, "result": result})
    return 0


def main(argv=None) -> int:
    level = os.environ.get("LUMOS_MEMORY_LOG", "WARNING")
    logging.basicConfig(stream=sys.stderr, level=level)
    if "LUMOS_MEMORY_LOG" not in os.environ:
        # The pinned HRR module warns on EVERY add once a category passes ~256 facts.
        logging.getLogger("pinned.holographic").setLevel(logging.ERROR)
    args = build_parser().parse_args(argv)
    if args.prefetch is not None:
        return run_prefetch(args)
    if args.extract:
        return run_extract(args)
    if args.render_now:
        return run_render_now(args)
    lm = _open(args)
    _startup_render(lm)
    try:
        if args.transport == "mcp":
            try:
                import mcp  # noqa: F401
            except ImportError:
                return serve_jsonrpc(lm)
            return serve_mcp(lm)
        return serve_jsonrpc(lm)
    finally:
        lm.close()


if __name__ == "__main__":
    sys.exit(main())
