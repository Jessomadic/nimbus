"""Offline exact-fingerprint source installer. Default dry-run; never migrates a DB.
Use only in a separately authorized stopped/quiescent deployment window.
Rollback is source-only; additive ledger and archives are preserved.
"""
from contextlib import closing
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3

PACKAGE = Path(__file__).resolve().parent
def fingerprint(p):
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None

def guarded(root, relative):
    p = root / relative
    if Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise ValueError("Invalid deployment path")
    for part in (p, *p.parents):
        if part.is_symlink() or getattr(part, "is_junction", lambda: False)():
            raise ValueError("Deployment links forbidden")
    if not p.resolve().is_relative_to(root.resolve()):
        raise ValueError("Deployment escape")
    return p

def atomic(p, data):
    temporary = p.with_name(p.name + ".nimbus-pending")
    # Exclusive creation also makes abandoned writes fail closed.
    with temporary.open("xb") as f:
        f.write(data); f.flush(); os.fsync(f.fileno())
    os.replace(temporary, p)

def install(root, backup, apply=False, rollback=False, db=None, resume=False):
    root, backup = Path(root).absolute(), Path(backup).absolute()
    entries = json.loads((PACKAGE/"deployment.json").read_text())
    recovery = resume or rollback
    if resume and rollback:
        raise ValueError("Choose resume or rollback")
    if recovery:
        receipt = guarded(backup, "deployment.json")
        if not receipt.is_file() or json.loads(receipt.read_text()) != entries:
            raise ValueError("Recovery requires matching completed backup manifest")
    plan = []
    for e in entries:
        target = guarded(root, e["target"])
        source = guarded(PACKAGE, e["source"])
        if fingerprint(source) != e["after"]:
            raise ValueError("Package fingerprint mismatch: "+e["source"])
        allowed = {e["before"], e["after"]} if recovery else {e["before"]}
        if fingerprint(target) not in allowed:
            raise ValueError("Exact-context mismatch: "+e["target"])
        if recovery and e["before"] is not None:
            original = guarded(backup,e["target"])
            if fingerprint(original) != e["before"]:
                raise ValueError("Backup fingerprint mismatch")
        plan.append((e,target,source))
    if not apply:
        return {"status":"dry_run","rollback":rollback,"files":len(plan)}
    if rollback:
        for e,target,source in plan:
            if fingerprint(target) == e["before"]:
                continue
            if fingerprint(target) != e["after"]:
                raise ValueError("Destination changed during rollback")
            if e["before"] is None:
                target.unlink()
            else:
                atomic(target,guarded(backup,e["target"]).read_bytes())
        return {"status":"rolled_back","database":"preserved"}
    if resume:
        for e,target,source in plan:
            if fingerprint(target) == e["after"]:
                continue
            if fingerprint(target) != e["before"]:
                raise ValueError("Destination changed during recovery")
            target.parent.mkdir(parents=True,exist_ok=True)
            atomic(target,source.read_bytes())
        return {"status":"installed","backup":str(backup),"database":"preserved"}
    guarded(backup, "deployment.json")
    # Refuse replay/overwrite of a preexisting deployment backup.
    backup.mkdir(parents=True,exist_ok=False)
    for e,target,source in plan:
        if e["before"] is not None:
            saved=guarded(backup,e["target"])
            saved.parent.mkdir(parents=True,exist_ok=True)
            with saved.open("xb") as f:
                f.write(target.read_bytes()); f.flush(); os.fsync(f.fileno())
    if db:
        db=Path(db).resolve()
        if not db.is_file():
            raise ValueError("Backup database must exist")
        with closing(sqlite3.connect(db.as_uri()+"?mode=ro",uri=True)) as src:
            with closing(sqlite3.connect(backup/"knowledge.sqlite3")) as dst:
                src.backup(dst)
                if dst.execute("PRAGMA integrity_check").fetchone()[0]!="ok":
                    raise ValueError("Invalid SQLite backup")
    (backup/"deployment.json").write_text(json.dumps(entries,indent=2))
    for e,target,source in plan:
        # Recheck before each write; partial install leaves immutable backups.
        if fingerprint(target)!=e["before"]:
            raise ValueError("Destination changed during deployment")
        target.parent.mkdir(parents=True,exist_ok=True)
        atomic(target,source.read_bytes())
    return {"status":"installed","backup":str(backup),"database":"not migrated"}

if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--root",required=True)
    p.add_argument("--backup",required=True)
    p.add_argument("--db")
    p.add_argument("--apply",action="store_true")
    p.add_argument("--rollback",action="store_true")
    p.add_argument("--resume",action="store_true")
    a=p.parse_args()
    print(json.dumps(install(a.root,a.backup,a.apply,a.rollback,a.db,a.resume)))
