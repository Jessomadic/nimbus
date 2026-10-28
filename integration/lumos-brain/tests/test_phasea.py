from contextlib import closing
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch
from test_publication import PublicationTests
from kb.publication import canonical, digest, immutable
import kb
R=Path(__file__).resolve().parents[1]
LIVE=Path("F:/Projects/Lumos/HermesPilot")
kb.__path__.append(str(LIVE/"integrations/knowledge_tools/kb"))
sys.path.insert(0,str(LIVE/"brain_viewer"))
sys.path.insert(0,str(R))
from kb.query import document_evidence, search_evidence
import installer

class PhaseATests(PublicationTests):
    def test_ordinary_provenance_and_hash_guard(self):
        m=self.manifest()
        receipt=self.send(m)
        doc=document_evidence(receipt["kb_document_id"],path=self.db)
        self.assertEqual(m["source_revision"],doc["publication"]["source_revision"])
        self.assertEqual(receipt["archive_path"],search_evidence("uniqueold",path=self.db)["results"][0]["publication"]["archive_path"])
        self.store.replace(doc["path"],"f"*64,".md",[dict(text="generic replacement",locator="lines:1-1",method="native")])
        self.assertNotIn("publication",document_evidence(doc["id"],path=self.db))

    def test_archive_commit_crash_reconcile(self):
        m=self.manifest()
        with patch.object(self.store,"commit_publication",side_effect=RuntimeError("crash-before-commit")):
            with self.assertRaisesRegex(RuntimeError,"crash-before"):
                self.send(m)
        self.assertEqual("not_committed",self.store.status(m["request_id"])["status"])
        self.source.unlink()
        result=self.send(m,extractor=lambda *a:self.fail("must use archived extraction"))
        self.assertEqual("committed",result["status"])
        changed=dict(m,title="different")
        with self.assertRaisesRegex(ValueError,"409"):
            self.send(changed)

    def test_archive_source_only_reconcile(self):
        m=self.manifest()
        folder=self.root/"archives"/m["request_id"]
        folder.mkdir(parents=True)
        immutable(folder/"source.md",self.source.read_bytes())
        self.source.unlink()
        self.assertEqual("committed",self.send(m)["status"])

    def test_real_brain_data_store_fixture(self):
        home=self.root/"home"
        target=home/"state/knowledge-base/knowledge.sqlite3"
        target.parent.mkdir(parents=True)
        m=self.manifest()
        receipt=self.send(m)
        import sqlite3
        with closing(sqlite3.connect(target)) as dst:
            self.store.db.backup(dst)
        spec=importlib.util.spec_from_file_location("phasea_brain_data",R/"brain_viewer/data.py")
        module=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        brain=module.BrainData(home)
        brain._knowledge()
        docs=[v for v in brain._records.values() if v["kind"]=="document" and v["metadata"].get("document_id")==receipt["kb_document_id"]]
        self.assertEqual(1,len(docs),brain._warnings)
        self.assertEqual(m["sha256"],docs[0]["metadata"]["publication"]["sha256"])
        self.assertEqual(m["title"],docs[0]["title"])
        from lumos_brain_mcp import dispatch
        from kb import brain_reads
        # Actual shared dispatch + actual BrainData, no dispatcher mock.
        result=brain_reads.read("brain_get",{"record_id":docs[0]["id"]},dispatch=dispatch,reader=brain)
        self.assertEqual(m["sha256"],result["item"]["metadata"]["publication"]["sha256"])

    def test_run_cli_supported_path(self):
        m=self.manifest()
        request=self.root/"request.json"
        request.write_bytes(canonical(m))
        args=[sys.executable,str(R/"knowledge_tools/run.py")]
        flags=["--db",str(self.db),"--input-root",str(self.root),"--archive-root",str(self.root/"archives")]
        result=subprocess.run(args+["publish-nimbus"]+flags+["--request",str(request)],capture_output=True,text=True)
        self.assertEqual(0,result.returncode,result.stdout+result.stderr)
        committed=json.loads(result.stdout)
        self.assertEqual("committed",committed["status"])
        result=subprocess.run(args+["publication-status"]+flags+["--request-id",m["request_id"]],capture_output=True,text=True)
        self.assertEqual(committed,json.loads(result.stdout))

    def test_installer_dryrun_backup_rollback_and_mismatch(self):
        root=self.root/"deployment"
        backup=self.root/"backup"
        entries=json.loads((R/"deployment.json").read_text())
        originals={"run.py":"run.py","query.py":"query.py","store.py":"store.py","mcp_server.py":"mcp_server.py","data.py":"data.py"}
        for e in entries:
            if e["before"] is not None:
                target=root/e["target"];target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(R/"originals"/originals[target.name],target)
        self.assertEqual("dry_run",installer.install(root,backup)["status"])
        self.assertFalse(backup.exists())
        real_atomic=installer.atomic
        def interrupt(p,data):
            if p.name == "query.py":
                raise RuntimeError("injected interrupted install")
            return real_atomic(p,data)
        with patch.object(installer,"atomic",side_effect=interrupt):
            with self.assertRaisesRegex(RuntimeError,"interrupted"):
                installer.install(root,backup,True,db=self.db)
        # Mixed before/after states must support rollback without touching the DB.
        self.assertEqual("rolled_back",installer.install(root,backup,True,True)["status"])
        backup=self.root/"resume-backup"
        with patch.object(installer,"atomic",side_effect=interrupt):
            with self.assertRaisesRegex(RuntimeError,"interrupted"):
                installer.install(root,backup,True,db=self.db)
        self.assertEqual("installed",installer.install(root,backup,True,resume=True)["status"])
        self.assertTrue((backup/"knowledge.sqlite3").is_file())
        self.assertEqual("dry_run",installer.install(root,backup,rollback=True)["status"])
        self.assertEqual("rolled_back",installer.install(root,backup,True,True)["status"])
        (root/entries[0]["target"]).write_text("unrelated changes")
        with self.assertRaisesRegex(ValueError,"Exact-context"):
            installer.install(root,self.root/"other")

    def test_windows_junction_and_escape_denial(self):
        import os
        from kb.publication import local
        if os.name != "nt":
            self.skipTest("Windows junction fixture")
        outside=self.root/"outside"
        outside.mkdir()
        linked=self.root/"junction"
        result=subprocess.run(["cmd","/c","mklink","/J",str(linked),str(outside)],capture_output=True,text=True)
        self.assertEqual(0,result.returncode,result.stdout+result.stderr)
        try:
            for operation in (lambda: local(linked/"draft.md",self.root),
                              lambda: installer.guarded(linked,"child.py"),
                              lambda: installer.guarded(self.root,"../escape")):
                with self.assertRaises(ValueError):
                    operation()
        finally:
            os.rmdir(linked)
