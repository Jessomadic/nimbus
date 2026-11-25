import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "knowledge_tools"))
from kb.publication import PublicationStore, publish
from kb import brain_reads

class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "draft.md"
        self.db = self.root / "kb.sqlite3"
        self.store = PublicationStore(self.db)
        self.addCleanup(self.store.close)
        self.install, self.doc = str(uuid.uuid4()), str(uuid.uuid4())
    def manifest(self, rev=1, previous=None, text="# Héllo\n\nuniqueold\n"):
        data = text.encode("utf-8")
        self.source.write_bytes(data)
        return dict(request_id=str(uuid.uuid4()), source_namespace="nimbus:"+self.install,
                    source_document_id=self.doc, source_revision=rev, expected_published_revision=previous,
                    sha256=hashlib.sha256(data).hexdigest(), markdown_path=str(self.source),
                    title="Title", source_uri=f"nimbus://{self.install}/{self.doc}?rev={rev}",
                    author_label="Author", published_by="Owner", published_at="2026-10-27T00:00:00Z", citations=[])
    def send(self, m, **kw):
        return publish(self.store, m, self.root, self.root / "archives", **kw)
    def test_draft_absent(self):
        self.manifest()
        self.assertEqual([], self.store.search("uniqueold"))
    def test_stable_update_archive_and_fts(self):
        first = self.send(self.manifest())
        second_m = self.manifest(2, 1, "# Renamed\nuniquenew\n")
        second_m["title"] = "Renamed"
        second = self.send(second_m)
        self.assertEqual(first["kb_document_id"], second["kb_document_id"])
        self.assertEqual([], self.store.search("uniqueold"))
        self.assertEqual(1, len(self.store.search("uniquenew")))
        self.assertIn("uniqueold", Path(first["archive_path"]).read_text(encoding="utf-8"))
    def test_reconcile_without_input_or_extraction(self):
        m = self.manifest()
        first = self.send(m)
        self.source.unlink()
        self.assertEqual(first, self.send(m, extractor=lambda *a: self.fail("re-extracted")))
        self.assertEqual(first, self.store.status(m["request_id"]))
    def test_payload_conflict(self):
        m = self.manifest()
        self.send(m)
        m["title"] = "changed"
        with self.assertRaisesRegex(ValueError, "409"): self.send(m)
    def test_revision_conflict(self):
        self.send(self.manifest())
        with self.assertRaisesRegex(ValueError, "409"): self.send(self.manifest(2))
        with self.assertRaisesRegex(ValueError, "409"): self.send(self.manifest(1, 1))
    def test_partial_preserves_lastgood(self):
        self.send(self.manifest())
        with self.assertRaisesRegex(ValueError, "Partial"):
            self.send(self.manifest(2,1), extractor=lambda *a: ([], [], ["failed"]))
        self.assertEqual(1, len(self.store.search("uniqueold")))
    def test_hash_utf8_and_path(self):
        m = self.manifest()
        m["sha256"] = "0"*64
        with self.assertRaisesRegex(ValueError, "Hash"): self.send(m)
        m["markdown_path"] = str(self.root / ".." / "escape.md")
        with self.assertRaises(ValueError): self.send(m)
    def test_transaction_rollback(self):
        self.send(self.manifest())
        self.store.db.execute("CREATE TRIGGER reject_pub BEFORE INSERT ON nimbus_publications BEGIN SELECT RAISE(ABORT,'injected'); END")
        self.store.db.commit()
        with self.assertRaises(Exception):
            self.send(self.manifest(2,1,"newunique"))
        self.assertEqual(1,len(self.store.search("uniqueold")))
        self.assertEqual([], self.store.search("newunique"))
    def test_concurrent_identical_request(self):
        m = self.manifest()
        results, errors = [], []
        def run():
            s = PublicationStore(self.db)
            try: results.append(publish(s,m,self.root,self.root/"archives"))
            except Exception as e: errors.append(str(e))
            finally: s.close()
        # No prestaging: both writers race through initial immutable creation.
        threads = [threading.Thread(target=run) for _ in range(2)]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual([],errors)
        self.assertEqual(2,len(results))
        self.assertEqual(results[0],results[1])
    def test_generic_compatibility(self):
        r = self.store.replace("generic.md","a"*64,".md",[dict(text="genericmarker",locator="lines:1",method="native")])
        self.assertEqual("complete",r["status"])
        self.assertEqual(1,len(self.store.search("genericmarker")))
    def test_overlay_read_only_delegation(self):
        seen=[]
        result=brain_reads.read("brain_get", {"scope":"overlay_memory","record_id":"x"},
                               lambda r,n,a: seen.append((n,a)) or {"error":"stale"}, object())
        self.assertEqual({"error":"stale"},result)
        self.assertEqual("brain_get",seen[0][0])
        with self.assertRaises(ValueError): brain_reads.read("brain_write_cited_link",{})
        self.assertEqual({"offset":0,"limit":100},brain_reads.page(-1,1000))

if __name__ == "__main__": unittest.main()
