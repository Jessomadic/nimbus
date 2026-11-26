"""Run a Python MCP stdio server with its JSON-RPC pipe moved off standard input.

    python [flags] mcp-stdio-isolate.py <server.py> [server args...]

Why: on Windows, a synchronous read pending on a pipe blocks every other operation on
that same handle. MCP servers keep a read pending on stdin for their whole life, so
anything else in the process (or a child it starts) that touches the standard input
handle hangs until the next message arrives. Observed live on 2026-11-25:
importing numpy or onnxruntime in a tool thread (rich-tools OCR) and ffprobe/worker
subprocesses (rich-tools transcription) never returned and Nimbus timed out the call.

The fix: duplicate the pipe to a private descriptor that only the MCP transport
reads (sys.stdin), and point fd 0 and STD_INPUT_HANDLE at NUL. Tool code and child
processes then see an empty, non-blocking standard input. stdout/stderr are unchanged.
"""
import os
import runpy
import sys


def isolate_stdin() -> None:
    if os.name != "nt":
        return
    import ctypes
    import msvcrt
    pipe_fd = os.dup(0)
    nul = os.open("NUL", os.O_RDONLY)
    os.dup2(nul, 0)
    os.close(nul)
    ctypes.windll.kernel32.SetStdHandle(ctypes.c_uint32(-10 & 0xFFFFFFFF), msvcrt.get_osfhandle(0))
    os.set_inheritable(pipe_fd, False)  # children must never inherit the MCP pipe
    sys.stdin = open(pipe_fd, "r", encoding="utf-8", closefd=True)


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: mcp-stdio-isolate.py <server.py> [args...]")
    script = os.path.abspath(sys.argv[1])
    isolate_stdin()
    sys.argv = [script, *sys.argv[2:]]
    sys.path[0] = os.path.dirname(script)
    runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    main()
