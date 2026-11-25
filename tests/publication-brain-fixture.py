"""Real overlay implementation with isolated fixture reader/storage; no live writes."""
import importlib.util, json, sqlite3, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import overlay_store as api
from link_store import fingerprint
spec=importlib.util.spec_from_file_location("bridge",Path(__file__).parents[1]/"runtime/publication-brain.py")
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
with tempfile.TemporaryDirectory() as root:
 class Reader:
  home=Path(root)
  def _guard(self,home,relative): return home/relative
  def _connect(self,path):
   from contextlib import contextmanager
   @contextmanager
   def connection():
    db=sqlite3.connect(path)
    try: yield db
    finally: db.close()
   return connection()
  def export(self): return {"items":[source,target]}
  def evidence(self,ident,limit=100): return {"items":[{"text":"Published authored evidence with attribution.","locator":"line:1"}]}
 r=Reader()
 source={"id":"source-real","kind":"document","title":"Publication","body":"Summary","source":"knowledge",
         "metadata":{"document_id":9,"source_sha256":"a"*64}}
 target={"id":"target-real","kind":"note","title":"Evidence","body":"Exact target evidence quote.","source":"memory","metadata":{}}
 dbpath=r._guard(r.home,"state/knowledge-base/knowledge.sqlite3");dbpath.parent.mkdir(parents=True)
 with sqlite3.connect(dbpath) as db:
  db.execute("CREATE TABLE chunks(document_id,locator,text)")
  db.execute("INSERT INTO chunks VALUES(9,'line:1','Published authored evidence with attribution.')")
 db.close()
 c={"record_id":target["id"],"fingerprint":fingerprint(target),"quote":target["body"]}
 bridge.dispatch(r,"validate",[c])
 links=bridge.dispatch(r,"prepare",{"receipt":{"kb_document_id":9,"sha256":"a"*64},"citations":[c]})
 p={**links[0],"request_id":"fixture-request-0001"}
 receipt=bridge.dispatch(r,"write",p)
 assert receipt["operation"]=="write_cited_link"
 assert bridge.dispatch(r,"status",p)==receipt
 target["body"]="Changed after committed write"
 assert bridge.dispatch(r,"status",p)==receipt
 assert bridge.dispatch(r,"write",p)==receipt
 try: bridge.dispatch(r,"validate",[c])
 except ValueError: pass
 else: raise AssertionError("stale citation accepted")
 try: bridge.dispatch(r,"write",{**p,"relationship":"different"})
 except ValueError: pass
 else: raise AssertionError("conflicting request accepted")
 print(json.dumps({"passed":True,"checks":["exact citations","KB id/hash resolution","real overlay write/readback","same key replay after source change","stale validation","payload conflict"]}))
