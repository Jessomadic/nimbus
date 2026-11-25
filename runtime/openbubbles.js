// Future-readiness only. No live transport, consumer, resolver, timer or startup hook.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
export const OPENBUBBLES_DEFAULTS=Object.freeze({version:1,enabled:false,consumeEvents:false,sendEnabled:false,autoStart:false,endpointRef:null,credentialRef:null,ownerBindingRef:null,bootstrapCursor:null,protocol:'openbubbles-local-subset-v1'});
const fail=message=>{throw new Error(message);};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function validateConfig(input={}) {
  const c={...OPENBUBBLES_DEFAULTS,...input};
  if(Object.keys(input).some(k=>!Object.hasOwn(OPENBUBBLES_DEFAULTS,k))) fail('unknown config key');
  for(const k of ['enabled','consumeEvents','sendEnabled','autoStart']) if(c[k]!==false) fail('live OpenBubbles disabled');
  for(const k of ['endpointRef','credentialRef','ownerBindingRef','bootstrapCursor']) if(c[k]!==null) fail('binding unavailable in disabled slice');
  if(c.version!==1||c.protocol!==OPENBUBBLES_DEFAULTS.protocol) fail('unsupported protocol');
  return Object.freeze(c);
}
export function createOpenBubblesAdapter(config={}) {
  validateConfig(config);
  return Object.freeze({status:()=>({state:'disabled',mockOnly:true}),invoke:()=>fail('OpenBubbles disabled')});
}
const effects=new Set(['slam','loud','gentle','invisible ink','echo','spotlight','balloons','confetti','love','lasers','fireworks','celebration']);
const mimes=new Set(['image/jpeg','image/png','image/gif','image/heic','image/webp','video/mp4','video/quicktime','audio/mpeg','audio/mp4','audio/x-m4a','application/pdf','text/plain']);
export function formatText(text) {
  if(typeof text!=='string'||!text.length) fail('empty text');
  const chunks=[];let chunk='';
  for(const point of text){if(Buffer.byteLength(chunk+point)>4000){chunks.push(chunk);chunk='';}chunk+=point;}
  if(chunk) chunks.push(chunk);
  return chunks;
}
export function planOutbound(p,ledger=[]) {
  if(!p||typeof p.operationId!=='string'||!p.operationId.length||p.operationId.length>128) fail('operation key required');
  if(!['text','attachments','reaction','typing','read','edit','unsend'].includes(p.kind)) fail('unsupported operation');
  const q=structuredClone(p);
  if(p.effect!==undefined){q.effect=p.effect.toLowerCase().replaceAll('_',' ');if(!effects.has(q.effect)) fail('invalid effect');}
  const target=id=>ledger.find(m=>m.guid===id&&m.chat===p.chat);
  if(p.replyToMessageGuid){if(!target(p.replyToMessageGuid)) fail('unknown native reply');}
  else if(p.replyPartIndex!==undefined) fail('reply part without target');
  for(const [key,max] of [['replyPartIndex',1000],['partIndex',4096]]) if(p[key]!==undefined&&(!Number.isInteger(p[key])||p[key]<0||p[key]>max)) fail('invalid part');
  if(p.kind==='text') q.chunks=formatText(p.text);
  if(p.kind==='edit'||p.kind==='unsend'){
    const m=target(p.targetGuid);if(!m||!m.ownText) fail('not owned text');
    if(p.kind==='edit'&&formatText(p.text).length!==1) fail('edit too long');
  }
  if(p.kind==='read'&&(!target(p.targetGuid)||target(p.targetGuid).ownText)) fail('read needs inbound target');
  if(p.kind==='reaction'){
    if(!target(p.targetGuid)||typeof p.reaction!=='string'||!p.reaction.trim()||p.reaction==='-'||Buffer.byteLength(p.reaction)>64) fail('invalid reaction');
  }
  if(p.kind==='attachments'){
    if(!Array.isArray(p.files)||p.files.length<1||p.files.length>4) fail('1..4 files required');
    q.files=p.files.map(f=>{
      const mime=String(f.mime).split(';')[0].toLowerCase();
      if(typeof f.name!=='string'||!f.name||Buffer.byteLength(f.name)>255||/[\x00-\x1f\x7f/\\:<>"|?*&]/.test(f.name)||!mimes.has(mime)) fail('invalid attachment metadata');
      if(!(f.bytes instanceof Uint8Array)||!f.bytes.length||f.bytes.length>25*1024*1024) fail('invalid attachment size');
      return {name:f.name,mime,size:f.bytes.length,sha256:createHash('sha256').update(f.bytes).digest('hex')};
    });
    if(p.text!==undefined&&p.text!==''&&formatText(p.text).length!==1) fail('caption too long');
  }
  return q;
}
// Explicit fixture-only store; production adapter above never opens this store.
// SQLite FULL transactions retain the attempt boundary before injected effects.
export class OpenBubblesFixture {
  constructor({path,owner,chat,transport,mockOnly}){
    if(mockOnly!==true||!owner||!chat||typeof transport!=='function') fail('explicit synthetic binding required');
    this.owner=owner;this.chat=chat;this.transport=transport;
    this.db=new DatabaseSync(path);
    this.db.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)");
    this.state=JSON.parse(this.db.prepare('SELECT value FROM state WHERE id=1').get()?.value||'{"cursor":0,"inbox":[],"outbox":{},"receipts":[]}');
    if(this.state.binding && (this.state.binding.owner!==owner||this.state.binding.chat!==chat)) {this.db.close();fail('fixture binding mismatch');}
    this.state.binding={owner,chat};
    for(const o of Object.values(this.state.outbox)) if(o.state==='dispatching') o.state='uncertain';
    this.save();
  }
  save(){this.db.prepare('INSERT INTO state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(this.state));}
  close(){this.db.close();}
  ingest(e,correlation){
    if(e.owner!==this.owner||e.chat!==this.chat||e.isFromMe!==false||e.kind!=='text'||!Array.isArray(e.participants)||e.participants.length!==1||e.participants[0]!==this.owner||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(e.guid)) fail('unauthorized inbound');
    if(!Number.isSafeInteger(e.sequence)||e.sequence<1) fail('invalid sequence');
    const digest=hash(e),old=this.state.inbox.find(x=>x.sequence===e.sequence||x.guid===e.guid);
    if(old){if(old.hash!==digest) fail('duplicate conflict');return {duplicate:true,correlation:old.correlation};}
    if(e.sequence!==this.state.cursor+1) fail('sequence gap');
    if(!correlation?.runId||!correlation?.topicId) fail('immutable correlation required');
    this.state.inbox.push({sequence:e.sequence,guid:e.guid,hash:digest,correlation:structuredClone(correlation)});
    this.state.cursor=e.sequence;this.save();return {duplicate:false};
  }
  prepare(p,correlation,ledger=[]){
    if(p.chat!==this.chat||!correlation?.runId||!correlation?.topicId) fail('binding/correlation mismatch');
    if(['__proto__','constructor','prototype'].includes(p.operationId)) fail('reserved operation key');
    const plan=planOutbound(p,ledger),digest=hash(plan),old=Object.hasOwn(this.state.outbox,p.operationId)?this.state.outbox[p.operationId]:null;
    if(old){if(old.hash!==digest||hash(old.correlation)!==hash(correlation)) fail('operation conflict');return structuredClone(old);}
    this.state.outbox[p.operationId]={hash:digest,plan,correlation:structuredClone(correlation),state:'queued',nativeGuid:null};
    this.save();return structuredClone(this.state.outbox[p.operationId]);
  }
  async submit(id){
    const o=this.state.outbox[id];if(!o||o.state!=='queued') fail('no automatic replay');
    if(Object.values(this.state.outbox).some(x=>x.state==='dispatching'||x.state==='uncertain')) fail('effect lane needs review');
    o.state='dispatching';this.save();
    try{
      const result=await this.transport(structuredClone(o.plan));
      if(!result||typeof result.nativeGuid!=='string'||!result.nativeGuid) fail('missing native receipt');
      o.nativeGuid=result.nativeGuid;o.state='submitted';this.save();
    }catch{ o.state='uncertain';this.save(); }
    return structuredClone(o);
  }
  receipt({nativeGuid,kind,sequence}){
    if(!['accepted','apnsConfirmed','delivered','read'].includes(kind)||!Number.isSafeInteger(sequence)||sequence<1) fail('invalid receipt');
    const r={nativeGuid,kind,sequence},old=this.state.receipts.find(x=>x.sequence===sequence);
    if(old&&hash(old)!==hash(r)) fail('receipt conflict');
    if(!old){this.state.receipts.push(r);this.save();}
  }
  status(id){
    const o=this.state.outbox[id];if(!o) fail('unknown operation');
    return {state:o.state,correlation:structuredClone(o.correlation),evidence:[...new Set(this.state.receipts.filter(r=>r.nativeGuid===o.nativeGuid).map(r=>r.kind))]};
  }
}
