"""Trusted local bridge: all validation/writes/readback through existing overlay API."""
import argparse, json, sys
from pathlib import Path

def dispatch(reader, op, payload):
    import overlay_store as api
    from link_store import fingerprint
    if op == "status":
        return api.replay(reader, "write_cited_link", payload)
    if op == "write":
        return api.write_link(reader, payload)
    rs = api.records(reader)
    if op == "validate":
        return [api.cited(reader, rs, c) for c in payload]
    if op != "prepare":
        raise ValueError("Unsupported operation")
    receipt, cites = payload["receipt"], payload["citations"]
    matches = [r for r in rs.values() if r["kind"] == "document"
               and r["metadata"].get("document_id") == receipt["kb_document_id"]
               and r["metadata"].get("source_sha256") == receipt["sha256"]]
    if len(matches) != 1:
        raise ValueError("Committed KB id/hash must resolve uniquely in Brain")
    source = matches[0]
    evidence = reader.evidence(source["id"], limit=100)["items"]
    ev = next(({"quote":e["text"][:800], "locator":e["locator"]}
               for e in evidence if len(e["text"]) >= 12 and e["locator"]), None)
    if not ev:
        raise ValueError("No supported exact source evidence")
    api.cited(reader, rs, {"record_id":source["id"], "fingerprint":fingerprint(source), **ev})
    links = []
    for c in cites:
        target = api.cited(reader, rs, c)
        if target["record_id"] == source["id"]:
            raise ValueError("Self citation is not an overlay link")
        links.append({"source":source["id"], "target":target["record_id"],
            "source_fingerprint":fingerprint(source), "target_fingerprint":target["fingerprint"],
            "relationship":"explicitly cites", "confidence":1.0,
            "explanation":"This authored Nimbus publication explicitly cites the target evidence; this link records attribution, not independent validation of either source.",
            "source_evidence":ev, "target_evidence":{"quote":target["quote"], "locator":target["locator"]}})
    return links

if __name__ == "__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--brain-root", required=True)
    p.add_argument("--home", required=True)
    p.add_argument("--operation", choices=["validate","prepare","write","status"], required=True)
    a=p.parse_args()
    sys.path.insert(0, str(Path(a.brain_root).resolve()))
    from data import BrainData
    value=json.loads(sys.stdin.read(1000001))
    print(json.dumps(dispatch(BrainData(a.home, cache_seconds=0),a.operation,value),ensure_ascii=False))
