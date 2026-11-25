"""Read-only delegation to existing Brain semantics, never overlay writes."""
from pathlib import Path
import sys

def read(name, args, dispatch=None, reader=None):
    if name not in {"brain_get", "brain_list", "brain_edges"}:
        raise ValueError("Read operation not allowed")
    if dispatch is None:
        root = Path(__file__).resolve().parents[3]
        sys.path.insert(0, str(root / "brain_viewer"))
        from lumos_brain_mcp import dispatch
        from data import BrainData
        reader = BrainData(root / "home")
    return dispatch(reader, name, args)

def page(offset, limit):
    return {"offset": max(0, int(offset)), "limit": max(1, min(100, int(limit)))}

def record(record_id, scope="record"):
    if not isinstance(record_id, str) or not 1 <= len(record_id) <= 100:
        raise ValueError("Invalid record id")
    return read("brain_get", {"record_id": record_id, "scope": scope})

def inferences(offset=0, limit=50):
    return read("brain_list", dict(scope="overlay_memories", **page(offset, limit)))

def edges(record_id="", offset=0, limit=50):
    if len(record_id) > 100:
        raise ValueError("Invalid record id")
    return read("brain_edges", dict(record_id=record_id, **page(offset, limit)))
