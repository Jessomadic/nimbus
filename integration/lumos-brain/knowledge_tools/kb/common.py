from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PILOT = ROOT.parents[1]
STATE = PILOT / "home" / "state" / "knowledge-base"


def run(args, timeout=120):
    """No shell interpolation or visible console; propagate actual failures."""
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    p = subprocess.run([str(a) for a in args], capture_output=True, timeout=timeout, **options)
    if p.returncode:
        raise RuntimeError(p.stderr.decode("utf-8", errors="replace")[-2000:] or f"Exit {p.returncode}")
    return p.stdout


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def local_file(path):
    raw = Path(path).absolute()
    if str(raw).startswith(("\\\\", "//")):
        raise ValueError("Select a local drive file")
    for part in (raw, *raw.parents):
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            raise ValueError("Links/junctions are excluded from ingestion")
    if not raw.is_file():
        raise FileNotFoundError(str(raw))
    attrs = getattr(raw.stat(), "st_file_attributes", 0)
    if attrs & (0x1000 | 0x40000 | 0x400000):
        raise ValueError("Cloud placeholder: download locally before ingestion")
    return raw.resolve()


def memory_guard(reserve_mb=500):
    import psutil
    mem = psutil.virtual_memory()
    if (mem.used + reserve_mb * 1024 * 1024) / mem.total > .9:
        raise RuntimeError("Work deferred: forecast exceeds the 90% RAM ceiling")
