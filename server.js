import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, q, parseBot, botDir, writeBotBrief, DATA_DIR, getSetting, setSetting } from './db.js';
import {defaultDisplayGroup,validateDisplayGroup} from './public/agent-groups.js';
import {normalizeSidebarLayout,moveSidebarGroup,normalizeSidebarOrder,moveSidebarKeys} from './public/sidebar-layout.js';
import https from 'node:https';
import os from 'node:os';
import { redact, encodeRedacted } from './redact.js';
import { addClient, broadcast, revokeClients, revalidateClients } from './events.js';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { runBot, stopRun, resumeRun, taskResult, runtimeQueues, drainRuntime, addMessage, updateMessage, botStatus, roomMembers, findMentions, markTraceWaiting, recoverRuns,startToolDevelopment } from './runner.js';
import { config, saveConfig } from './runtime/config.js';
import { cloudStatus, CodexClient } from './runtime/codex.js';
import { localCatalog } from './runtime/local.js';
import { resources } from './runtime/resources.js';
import { browsers, connectors, migrateConnectorSecrets, coreTools, maintenance, terminals } from './runtime/tools.js';
import { protect, unprotect } from './runtime/credentials.js';
import { events as taskEvents, event as taskEvent } from './runtime/journal.js';
import { registerRuntimeRoutes } from './runtime/http.js';
import { startLocalService } from './runtime/local-service.js';
import {validateParentLink} from './runtime/hierarchy.js';
import {directLocal,secureRequest,requestIp,sameOriginRequest} from './runtime/network.js';
import {SessionStore,LoginThrottle} from './runtime/auth.js';
import {PasskeyStore} from './runtime/passkeys.js';
import { answerQuestion } from './runtime/questions.js';
import { capabilities } from './runtime/capabilities.js';
import {roleToolCoverage} from './runtime/toolsets/index.js';
import { TEMPLATES, PLUGINS, publicPlugin } from './catalog.js';
import { startScheduler, nextRun, isValidCron } from './scheduler.js';
import { getPlanUsage } from './planusage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const PORT = Number(process.env.PORT || 8787);
process.env.PORT = String(PORT);
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.NIMBUS_PASSWORD || (process.env.NIMBUS_PASSWORD_DPAPI ? await unprotect(fs.readFileSync(path.resolve(process.env.NIMBUS_PASSWORD_DPAPI),'utf8')) : '');
const ALLOWED_EMAILS = (process.env.NIMBUS_ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const OWNER_USERNAME=(process.env.NIMBUS_USERNAME||'').trim();
const OWNER_MODE=Boolean(OWNER_USERNAME);
const PASSKEY_ORIGIN=process.env.NIMBUS_PUBLIC_ORIGIN||'';
if(OWNER_MODE&&(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(OWNER_USERNAME)||!PASSWORD||ALLOWED_EMAILS.length))throw new Error('Username mode requires a valid 3–64 character username, a password and no email-account mode');
const WINDOW_BUDGET = Number(process.env.NIMBUS_WINDOW_BUDGET_USD || 0);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const bootSourceHash = maintenance.inventory().hash;
const startedAt = new Date().toISOString();

await migrateConnectorSecrets();
const localService=await startLocalService();
recoverRuns();
startScheduler();

// ---------- approvals ----------
// The rule "Always allow" saves: the exact command, or a prefix pattern of its first words.
function rememberRule(tool, input, kind) {
  if (tool !== 'shell') return tool;
  const cmd = String(input.command || '').trim();
  if (kind !== 'pattern') return `shell(${cmd})`;
  return `shell(${commandPrefix(cmd)}*)`;
}
function commandPrefix(cmd) {
  const words = cmd.split(/\s+/);
  const keep = [];
  for (const w of words) { if (keep.length >= 2 || /^[-'"$|;&><]/.test(w)) break; keep.push(w); }
  return (keep.join(' ') || words[0]) + ' ';
}
// ---------- helpers ----------
const json = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json','cache-control':'no-store','x-content-type-options':'nosniff' }); res.end(JSON.stringify(data)); };
async function body(req, limit = 2e6) {
  let s = '';
  for await (const c of req) { s += c; if (Buffer.byteLength(s) > limit) throw Object.assign(new Error('Request body is too large'),{statusCode:413}); }
  try{return s ? JSON.parse(s) : {};}catch{throw Object.assign(new Error('Invalid JSON request'),{statusCode:400});}
}
function tailMemory(botId, n = 3) {
  try {
    return fs.readFileSync(path.join(botDir(botId), 'MEMORY.md'), 'utf8').split('\n')
      .map((l) => l.replace(/^[-*]\s*/, '').trim()).filter((l) => l && !l.startsWith('#')).slice(-n);
  } catch { return []; }
}
function botView(b) {
  const st = botStatus.get(b.id) || { state: 'idle', label: 'Idle' };
  const today = q("SELECT COUNT(*) AS runs, COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(ended_at-started_at),0) AS secs FROM runs WHERE bot_id=? AND started_at >= unixepoch('now','localtime','start of day','utc')").get(b.id);
  const pending = q("SELECT COUNT(*) AS n FROM approvals WHERE bot_id=? AND status='pending'").get(b.id).n;
  return { ...b, status: pending ? { state: 'waiting', label: 'Waiting on you' } : st, today };
}

function state(req) {
  const bots = q('SELECT * FROM bots ORDER BY id').all().map(parseBot).map(botView);
  const rooms = q('SELECT * FROM rooms ORDER BY id').all().map((r) => ({ ...r, members: roomMembers(r.id).map((m) => m.id) }));
  const approvals = q("SELECT * FROM approvals WHERE status='pending' ORDER BY id").all().map((a) => ({ ...a, input: JSON.parse(a.input || '{}') }));
  const routines = q('SELECT * FROM routines ORDER BY id').all();
  const upNext = routines.filter((r) => r.enabled).map((r) => ({ ...r, next: nextRun(r.cron)?.getTime() }))
    .filter((r) => r.next).sort((a, b) => a.next - b.next).slice(0, 6);
  const learned = bots.flatMap((b) => tailMemory(b.id, 2).map((text) => ({ botId: b.id, text }))).slice(-5);
  const windowCost = q("SELECT COALESCE(SUM(cost_usd),0) AS c FROM runs WHERE started_at >= unixepoch() - 5*3600").get().c;
  const running = q("SELECT COUNT(*) AS n FROM runs WHERE status IN ('routing','running','waiting_local','waiting_cloud','waiting_approval')").get().n;
  // Token usage and task counts; subscription use is not represented as API charges.
  const byBot = q("SELECT bot_id, COUNT(*) AS runs, COALESCE(SUM(input_tokens+output_tokens),0) AS cost FROM runs WHERE started_at >= unixepoch() - 7*86400 GROUP BY bot_id ORDER BY cost DESC").all();
  const last = {};
  for (const m of q(`SELECT m.thread, m.author, m.kind, m.body, m.created_at FROM messages m
      JOIN (SELECT thread, MAX(id) AS id FROM messages WHERE kind IN ('text','error','approval') GROUP BY thread) x ON x.id = m.id`).all()) {
    let text = m.body;
    if (m.kind === 'approval') { try { text = 'Needs approval: ' + JSON.parse(m.body).tool; } catch {} }
    last[m.thread] = { author: m.author, text: String(text).replace(/\s+/g, ' ').slice(0, 120), at: m.created_at };
  }
  const botPlugins = {};
  for (const r of q('SELECT * FROM bot_plugins').all()) (botPlugins[r.bot_id] ||= []).push(r.plugin_id);
  for (const b of bots) b.plugins = botPlugins[b.id] || [];
  const installed = q('SELECT id FROM plugins').all().map((r) => r.id);
  const sideOrder = JSON.parse(getSetting('side_order') || 'null'); // custom sidebar order, or null = most recent first
  return { sideOrder, sidebarLayout:readSidebarLayout(), bots, rooms, approvals, routines, upNext, learned, last, installed, user: req?.user || null, computers: false, toolCatalog:coreTools.filter(tool=>tool.function.name!=='worker_result').map(tool=>({name:tool.function.name,description:tool.function.description})),queues: runtimeQueues(), usage: { windowCost, budget: WINDOW_BUDGET, running, byBot } };
}

function postToThread(thread, text, files = []) {
  const msg = addMessage(thread, 'user', 'text', text, null, files);
  // Attachments are shared host paths available through Nimbus tools.
  if (files.length) text = `${text || 'See the attached files.'}\n\nAttached files (use view_image for pixels; read_file or shell for other formats):\n` + files.map((f) => `- ${uploadPath(f)} (${f.type || 'file'}, ${f.size} bytes)`).join('\n');
  if (thread.startsWith('bot:')) {
    runBot({ botId: Number(thread.slice(4)), thread, prompt: text,originMessageId:msg.id });
  } else if (thread.startsWith('room:')) {
    const roomId = Number(thread.slice(5));
    const room = q('SELECT * FROM rooms WHERE id=?').get(roomId);
    const members = roomMembers(roomId);
    let targets = findMentions(text, members);
    if (!targets.length) targets = members.filter((m) => m.id === room.lead_bot_id);
    if (!targets.length && members[0]) targets = [members[0]];
    for (const t of targets) runBot({ botId: t.id, thread, prompt: text, source: 'the user',originMessageId:msg.id });
  }
  return msg;
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
registerRuntimeRoutes({route,body,json});
const {registerDocumentRoutes}=await import('./runtime/documents.js');
const {workspaceDownload}=await import('./runtime/download-path.js');
registerDocumentRoutes({route,body,json,db});
route('GET','/api/bots/:id/download',(req,res,p,url)=>{
  if(!/^\d+$/.test(p.id)||!q('SELECT id FROM bots WHERE id=?').get(p.id))return json(res,404,{error:'not found'});
  const file=workspaceDownload(botDir(Number(p.id)),url.searchParams.get('path')||'');
  if(!file)return json(res,404,{error:'not found'});
  const name=path.basename(file).replace(/[\x00-\x1f\x7f]/g,'')||'download';
  res.writeHead(200,{'content-type':'application/octet-stream','content-length':fs.statSync(file).size,
    'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(name),
    'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});
  const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);
});
route('GET','/health',(req,res)=>json(res,200,directLocal(req)?{ok:true,version:'0.2.0',pid:process.pid,startedAt,sourceHash:bootSourceHash,lumosConnected:false}:{ok:true}));
route('GET','/api/updates',(req,res,p,url)=>json(res,200,maintenance.status(url.searchParams.get('snapshotId')||undefined)));
route('GET','/api/capabilities',(req,res)=>json(res,200,{fullCodexParity:false,capabilities,roleTools:roleToolCoverage(TEMPLATES),tools:coreTools.map(t=>({name:t.function.name,description:t.function.description}))}));
route('GET','/api/questions',(req,res)=>json(res,200,q("SELECT id,run_id,questions,status FROM task_questions WHERE status='pending' ORDER BY id").all().map(row=>({...row,questions:JSON.parse(row.questions)}))));
route('POST','/api/questions/:id/answer',async(req,res,p)=>{const b=await body(req);const result=answerQuestion(p.id,b.answers);broadcast('state_changed',{});json(res,200,{id:result.id,status:result.status});});
route('POST','/api/updates',async(req,res)=>{
  const b=await body(req);
  if(b.action==='snapshot')return json(res,200,maintenance.snapshot());
  if(b.action==='validate')return json(res,200,await maintenance.validate(b.snapshotId));
  if(b.action==='apply')return json(res,202,maintenance.apply(b.snapshotId));
  return json(res,400,{error:'Choose snapshot, validate or apply'});
});
route('POST','/api/admin/shutdown',(req,res)=>{if(!adminAuth(req))return json(res,403,{error:'Local administration required'});json(res,200,{ok:true});setTimeout(()=>shutdown(),100);});
const localTickets=new Map();
route('POST','/api/admin/login-ticket',(req,res)=>{if(!adminAuth(req))return json(res,403,{error:'Local administration required'});if(ACCOUNTS||OWNER_MODE)return json(res,403,{error:'Sign in with the account credentials and required factors'});const ticket=crypto.randomBytes(32).toString('hex');localTickets.set(ticket,Date.now()+60000);json(res,200,{url:`http://127.0.0.1:${PORT}/local-login?ticket=${ticket}`});});
route('GET','/local-login',(req,res,p,url)=>{if(!directLocal(req))return json(res,403,{error:'This sign-in method is local to the Nimbus PC'});const ticket=url.searchParams.get('ticket'),until=localTickets.get(ticket);localTickets.delete(ticket);if(!until||until<Date.now())return json(res,403,{error:'Local sign-in link expired'});res.writeHead(302,{'set-cookie':newSessionCookie(req),location:'/', 'cache-control':'no-store','referrer-policy':'no-referrer'});res.end();});

route('GET', '/api/state', (req, res) => json(res, 200, state(req)));

route('GET', '/api/events', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  const sessionToken=cookieToken(req);
  addClient(res,{sessionToken,authorized:()=>adminAuth(req)||(!AUTH_ON&&directLocal(req))||Boolean(sessions.authenticate(sessionToken,{touch:false}))});
});

route('GET', '/api/threads/:thread/messages', (req, res, p, url) => {
  const before = Number(url.searchParams.get('before') || 1e15);
  const rows = q('SELECT * FROM messages WHERE thread=? AND id<? ORDER BY id DESC LIMIT 80').all(decodeURIComponent(p.thread), before).reverse();
  json(res, 200, rows);
});

route('POST', '/api/threads/:thread/messages', async (req, res, p) => {
  const { text = '', files: ids = [],requestId } = await body(req);
  const files = (Array.isArray(ids) ? ids : []).slice(0, 10).map(readUpload).filter(Boolean);
  if (!String(text).trim() && !files.length) return json(res, 400, { error: 'empty' });
  const thread=decodeURIComponent(p.thread),key=requestId==null?null:String(requestId);
  if(key&&key.length>200)return json(res,400,{error:'requestId is too long'});
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify({thread,text:String(text).trim(),files:files.map(f=>f.id)})).digest('hex');
  const previous=key&&q('SELECT * FROM message_requests WHERE request_key=?').get(key);
  if(previous){if(previous.fingerprint!==fingerprint)return json(res,409,{error:'requestId was used for different instructions'});return json(res,200,{...q('SELECT * FROM messages WHERE id=?').get(previous.message_id),replayed:true});}
  db.exec('BEGIN IMMEDIATE');let message;
  try{message=postToThread(thread,String(text).trim(),files);if(key)q('INSERT INTO message_requests VALUES (?,?,?)').run(key,fingerprint,message.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  json(res,200,message);
});

// ---------- uploads ----------
// Each upload lives in data/uploads/<id>/ with the original file and meta.json.
const UPLOADS = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD = 20 * 1024 * 1024;
const safeName = (n) => String(n || 'file').replace(/[\/\\\0]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file';
const uploadPath = (f) => path.join(UPLOADS, f.id, f.name);
function readUpload(id) {
  if (!/^[a-f0-9]{24}$/.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(UPLOADS, id, 'meta.json'), 'utf8')); } catch { return null; }
}
route('POST', '/api/uploads', async (req, res) => {
  const { name, type, data } = await body(req, Math.ceil(MAX_UPLOAD * 1.4) + 1000);
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length) return json(res, 400, { error: 'Empty file' });
  if (buf.length > MAX_UPLOAD) return json(res, 413, { error: 'Files can be up to 20 MB' });
  const f = { id: crypto.randomBytes(12).toString('hex'), name: safeName(name), type: String(type || '').slice(0, 100), size: buf.length };
  fs.mkdirSync(path.join(UPLOADS, f.id), { recursive: true });
  fs.writeFileSync(uploadPath(f), buf);
  fs.writeFileSync(path.join(UPLOADS, f.id, 'meta.json'), JSON.stringify(f));
  json(res, 200, f);
});
const INLINE = /^image\/(png|jpe?g|gif|webp|avif)$|^application\/pdf$/;
route('GET', '/api/files/:id/:name', (req, res, p) => {
  const f = readUpload(p.id);
  if (!f) return json(res, 404, { error: 'not found' });
  // Only safe types open in the browser; anything else (HTML, SVG…) downloads, so it can't run script here.
  const inline = INLINE.test(f.type);
  res.writeHead(200, { 'content-type': inline ? f.type : 'application/octet-stream', 'content-length': f.size, 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", 'cache-control': 'no-store',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}` });
  fs.createReadStream(uploadPath(f)).pipe(res);
});

// Restart the service once no bot is mid-run (a restart kills running bots, including one that asked for it).
// Windows supervisor restarts on exit code 75 after the worker queue drains.
let restartWait;
function requestRestart() {
  if(!maintenance.supervised())throw new Error('Start Nimbus with Start-Nimbus.ps1 before requesting a restart');
  if(restartWait)return;
  restartWait = setInterval(() => {
    // Per-worker promises can still be queued before acquiring a shared slot.
    const outstanding=q("SELECT count(*) AS n FROM runs WHERE status IN ('queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input')").get().n;
    if (!outstanding && !runtimeQueues().workers.active && !runtimeQueues().workers.queued && !terminals.active().length) {
      clearInterval(restartWait);restartWait=null;
      try{maintenance.assertPendingSource();shutdown(75);}
      catch(error){maintenance.failPending(error.message);console.error('Restart cancelled:',error.message);}
    }
  }, 500);
}
maintenance.requestRestart=requestRestart;
route('POST', '/api/admin/restart', (req, res) => {
  requestRestart();json(res, 202, { ok: true, note: 'Nimbus will restart after current tasks finish.' });
});

// Bots
function cleanBot(b) {
  const out = {};
  if(Object.hasOwn(b,'display_group'))out.display_group=validateDisplayGroup(b.display_group);
  for (const k of ['name', 'role', 'instructions', 'color', 'model', 'default_model', 'shape', 'runtime', 'template']) if (b[k] !== undefined) out[k] = String(b[k]);
  if(b.default_model!==undefined&&!['','local','luna','terra','sol','astra'].includes(b.default_model))throw new Error('Invalid role model preference');
  if(b.template!==undefined&&b.template!==''&&!TEMPLATES.some(t=>t.id===b.template))throw new Error('Unknown specialist profile');
  if(b.parent_bot_id!==undefined){const parent=b.parent_bot_id==null||b.parent_bot_id===''?null:Number(b.parent_bot_id);if(parent!==null&&(!Number.isSafeInteger(parent)||parent<=0))throw new Error('Invalid parent worker');out.parent_bot_id=parent;}
  if (b.model !== undefined && !['', 'auto', 'local', 'luna', 'terra', 'sol', 'astra'].includes(b.model)) throw new Error('Choose Auto, Local, Luna, Terra, Sol or Astra');
  if (b.runtime !== undefined && !['auto', 'local', 'luna', 'terra', 'sol', 'astra'].includes(b.runtime)) throw new Error('Invalid worker runtime');
  if (b.tools !== undefined) { if (!Array.isArray(b.tools) || b.tools.some(n => !coreTools.some(t => t.function.name === n))) throw new Error('Invalid tool selection'); out.tools = JSON.stringify(b.tools); }
  if (b.effort !== undefined) { if (!EFFORTS.includes(b.effort)) throw new Error('bad effort'); out.effort = b.effort; }
  for (const k of ['approval_rules', 'allow_rules']) if (b[k] !== undefined) out[k] = JSON.stringify((b[k] || []).map(String).filter(Boolean));
  return out;
}
function coordinatorParent(){
  const roots=q("SELECT id FROM bots WHERE template='orchestrator' ORDER BY id LIMIT 2").all();
  if(roots.length>1)throw Object.assign(new Error('Multiple Orchestrator agents require setup review; no parent was selected'),{statusCode:409});
  return roots[0]?.id||null;
}
function validateCoordinatorFields(id,fields){
  const current=id==null?null:q('SELECT id,template,parent_bot_id FROM bots WHERE id=?').get(Number(id));
  const profile=fields.template??current?.template;
  if(current?.template==='orchestrator'&&profile!=='orchestrator')throw Object.assign(new Error('The designated Orchestrator must retain its coordinator profile'),{statusCode:400});
  if(profile!=='orchestrator')return;
  const parent=Object.hasOwn(fields,'parent_bot_id')?fields.parent_bot_id:current?.parent_bot_id;
  if(parent!=null)throw Object.assign(new Error('The Orchestrator is the top-level agent and cannot have a parent'),{statusCode:400});
  if(q("SELECT id FROM bots WHERE template='orchestrator' AND id!=? LIMIT 1").get(Number(id)||-1))throw Object.assign(new Error('An Orchestrator already exists; use the existing coordinator'),{statusCode:409});
}
function saveBot(id, fields) {
  validateCoordinatorFields(id,fields);
  if(Object.hasOwn(fields,'parent_bot_id'))validateParentLink(Number(id),fields.parent_bot_id,q('SELECT id,parent_bot_id FROM bots').all());
  const keys = Object.keys(fields);
  if (keys.length) q(`UPDATE bots SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => fields[k]), id);
  const bot = parseBot(q('SELECT * FROM bots WHERE id=?').get(id));
  writeBotBrief(bot);
  broadcast('state_changed', {});
  return bot;
}
route('POST', '/api/bots', async (req, res) => {
  const b = await body(req);
  if (!b.name?.trim()) return json(res, 400, { error: 'name required' });
  const fields=cleanBot(b);if(!Object.hasOwn(fields,'display_group'))fields.display_group=defaultDisplayGroup(fields.template);if(!Object.hasOwn(fields,'parent_bot_id')&&fields.template!=='orchestrator')fields.parent_bot_id=coordinatorParent();validateCoordinatorFields(null,fields);if(Object.hasOwn(fields,'parent_bot_id'))validateParentLink(null,fields.parent_bot_id,q('SELECT id,parent_bot_id FROM bots').all());
  const defaults = JSON.stringify(['shell(git push*)', 'shell(*Remove-Item*)', 'shell(*gh pr merge*)', 'mcp__*send*', 'mcp__*delete*', 'mcp__*pay*', 'mcp__*create_event*','automation_schedule(enable)']);
  const r = q('INSERT INTO bots (name, approval_rules, tools,display_group) VALUES (?,?,?,?)').run(b.name.trim(), defaults,JSON.stringify(coreTools.map(t=>t.function.name).filter(n=>n!=='worker_result')),fields.display_group);
  json(res, 200, saveBot(r.lastInsertRowid, fields));
});
route('PATCH', '/api/bots/:id', async (req, res, p) => {
  const input=await body(req);
  if(Object.hasOwn(input,'expected_parent_bot_id')){
    const expected=input.expected_parent_bot_id,current=q('SELECT parent_bot_id FROM bots WHERE id=?').get(Number(p.id));
    if(expected!==null&&(!Number.isSafeInteger(expected)||expected<1))return json(res,400,{error:'expected_parent_bot_id must be null or a positive integer'});
    if(!current)return json(res,404,{error:'Worker not found'});
    if(current.parent_bot_id!==expected)return json(res,409,{error:'Worker parent changed; refresh the roster before applying this assignment'});
  }
  return json(res,200,saveBot(Number(p.id),cleanBot(input)));
});
route('DELETE', '/api/bots/:id', (req, res, p) => {
  q('UPDATE bots SET parent_bot_id=NULL WHERE parent_bot_id=?').run(p.id);
  q('DELETE FROM bots WHERE id=?').run(p.id);
  q('DELETE FROM room_members WHERE bot_id=?').run(p.id);
  q('DELETE FROM routines WHERE bot_id=?').run(p.id);
  broadcast('state_changed', {});
  json(res, 200, { ok: true });
});
// ---------- bot computers ----------
const viewerUrl = (port) => { const u = new URL(agentConfig().url); return `http://${u.hostname}:${port}/`; };
route('GET', '/api/bots/:id/files', (req,res,p) => {
  const root = botDir(p.id), files=[];
  function walk(dir) { for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const file=path.join(dir,entry.name); if(entry.isDirectory()) walk(file); else if(entry.isFile()) {
      const stat=fs.statSync(file); files.push({name:entry.name,path:path.relative(root,file),size:stat.size,mtime:stat.mtimeMs/1000});
    }
  }} walk(root); json(res,200,{files});
});
route('GET','/api/bots/:id/file',(req,res,p,url)=>{
  const root=botDir(p.id), file=path.resolve(root,url.searchParams.get('path')||'');
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,404,{error:'File not found'});
  res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="'+path.basename(file).replace(/["\\]/g,'_')+'"'});fs.createReadStream(file).pipe(res);
});

route('GET', '/api/bots/:id/memory', (req, res, p) => json(res, 200, { text: fs.readFileSync(path.join(botDir(p.id), 'MEMORY.md'), 'utf8') }));
route('PUT', '/api/bots/:id/memory', async (req, res, p) => {
  fs.writeFileSync(path.join(botDir(p.id), 'MEMORY.md'), String((await body(req)).text || ''));
  broadcast('state_changed', {});
  json(res, 200, { ok: true });
});
route('POST', '/api/bots/:id/reset', (req, res, p) => {
  q('DELETE FROM sessions WHERE bot_id=?').run(p.id);
  q('DELETE FROM worker_history WHERE bot_id=?').run(p.id);
  addMessage('bot:' + p.id, 'system', 'note', 'Started a fresh conversation. Memory is kept.');
  json(res, 200, { ok: true });
});

// Routines
// ---------- marketplace ----------
// Nimbus connectors are explicitly configured and available to either model route.
route('GET', '/api/marketplace', (req,res) => {
  const installed=new Set(q('SELECT id FROM plugins').all().map(p=>p.id));
  const added=new Set(q("SELECT template FROM bots WHERE template != ''").all().map(p=>p.template));
  json(res,200,{templates:TEMPLATES.map(t=>({...t,display_group:defaultDisplayGroup(t.id),added:added.has(t.id)})),
    plugins:PLUGINS.map(p=>({...publicPlugin(p),installed:p.kind==='builtin'||installed.has(p.id)})),connectors:[]});
});
route('POST', '/api/templates/:id/add', (req, res, p) => {
  const t = TEMPLATES.find((x) => x.id === p.id);
  if (!t) return json(res, 404, { error: 'not found' });
  const parent=t.parent_profile==='orchestrator'?{id:coordinatorParent()}:t.parent_profile?q('SELECT id FROM bots WHERE template=? ORDER BY id LIMIT 1').get(t.parent_profile):null;
  validateCoordinatorFields(null,{template:t.id,parent_bot_id:parent?.id||null});
  const r = q('INSERT INTO bots (name, role, instructions, color, effort, shape, template, approval_rules, model, default_model, tools,parent_bot_id,display_group) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(t.name, t.role, t.instructions, t.color, t.effort, t.shape, t.id, JSON.stringify(t.approval_rules),t.model||'auto',t.default_model||'',JSON.stringify(t.tools),parent?.id||null,defaultDisplayGroup(t.id));
  const id = Number(r.lastInsertRowid);
  for (const rt of t.routines || []) q('INSERT INTO routines (bot_id, cron, prompt) VALUES (?,?,?)').run(id, rt.cron, rt.prompt);
  const installed = new Set(q('SELECT id FROM plugins').all().map((x) => x.id));
  for (const pid of t.plugins || []) {
    const pl = PLUGINS.find((x) => x.id === pid);
    if (pl && (pl.kind === 'builtin' || installed.has(pid))) q('INSERT OR IGNORE INTO bot_plugins VALUES (?,?)').run(id, pid);
  }
  json(res, 200, saveBot(id, {}));
});
route('POST', '/api/plugins/:id', async (req, res, p) => {
  const pl = PLUGINS.find((x) => x.id === p.id);
  if (!pl || pl.kind !== 'mcp') return json(res, 404, { error: 'not found' });
  const { secrets = {} } = await body(req);
  const clean = {};
  for (const f of pl.fields || []) {
    const v = String(secrets[f.key] || '').trim();
    if (!v) return json(res, 400, { error: `${f.label} is required` });
    clean[f.key] = v;
  }
  q('INSERT INTO plugins (id, secrets) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET secrets=excluded.secrets').run(pl.id, await protect(JSON.stringify(clean)));
  broadcast('state_changed', {}); json(res, 200, { ok: true });
});
route('DELETE', '/api/plugins/:id', (req, res, p) => {
  q('DELETE FROM plugins WHERE id=?').run(p.id);
  q('DELETE FROM bot_plugins WHERE plugin_id=?').run(p.id);
  broadcast('state_changed', {}); json(res, 200, { ok: true });
});
route('PUT', '/api/bots/:id/plugins', async (req, res, p) => {
  const ids = ((await body(req)).plugins || []).map(String).filter((id) => PLUGINS.some((x) => x.id === id));
  q('DELETE FROM bot_plugins WHERE bot_id=?').run(p.id);
  for (const id of ids) q('INSERT OR IGNORE INTO bot_plugins VALUES (?,?)').run(p.id, id);
  broadcast('state_changed', {}); json(res, 200, { ok: true });
});

route('POST', '/api/routines', async (req, res) => {
  const r = await body(req);
  if (!isValidCron(r.cron)) return json(res, 400, { error: 'Schedule must be a 5-part cron like "0 9 * * 1-5"' });
  q('INSERT INTO routines (bot_id, cron, prompt, quiet) VALUES (?,?,?,?)').run(r.bot_id, r.cron.trim(), r.prompt || '', r.quiet ? 1 : 0);
  broadcast('state_changed', {}); json(res, 200, { ok: true });
});
route('PATCH', '/api/routines/:id', async (req, res, p) => {
  const r = await body(req);
  if (r.cron !== undefined && !isValidCron(r.cron)) return json(res, 400, { error: 'Invalid schedule' });
  const cur = q('SELECT * FROM routines WHERE id=?').get(p.id);
  if (r.cron !== undefined && !isValidCron(r.cron)) return json(res,400,{error:'Invalid cron schedule'});
  q('UPDATE routines SET cron=?, prompt=?, enabled=?, quiet=? WHERE id=?').run(r.cron ?? cur.cron, r.prompt ?? cur.prompt, r.enabled ?? cur.enabled, r.quiet === undefined ? cur.quiet : r.quiet ? 1 : 0, p.id);
  broadcast('state_changed', {}); json(res, 200, { ok: true });
});
route('DELETE', '/api/routines/:id', (req, res, p) => { q('DELETE FROM routines WHERE id=?').run(p.id); broadcast('state_changed', {}); json(res, 200, { ok: true }); });
route('POST', '/api/routines/:id/run', (req, res, p) => {
  const r = q('SELECT * FROM routines WHERE id=?').get(p.id);
  runBot({ botId: r.bot_id, thread: 'bot:' + r.bot_id, prompt: r.prompt, source: 'schedule', quiet: !!r.quiet });
  json(res, 200, { ok: true });
});

// Rooms (group chats)
function saveRoom(id, r) {
  const cur = q('SELECT * FROM rooms WHERE id=?').get(id);
  q('UPDATE rooms SET name=?, goal=?, lead_bot_id=?, bots_can_talk=? WHERE id=?').run(
    (r.name ?? cur.name).replace(/^#\s*/, ''), r.goal ?? cur.goal, r.lead_bot_id ?? cur.lead_bot_id, r.bots_can_talk === undefined ? cur.bots_can_talk : r.bots_can_talk ? 1 : 0, id);
  if (Array.isArray(r.members)) {
    q('DELETE FROM room_members WHERE room_id=?').run(id);
    for (const b of r.members) q('INSERT OR IGNORE INTO room_members (room_id, bot_id) VALUES (?,?)').run(id, b);
  }
  broadcast('state_changed', {});
  return q('SELECT * FROM rooms WHERE id=?').get(id);
}
route('POST', '/api/rooms', async (req, res) => {
  const r = await body(req);
  if (!r.name?.trim()) return json(res, 400, { error: 'name required' });
  const ins = q('INSERT INTO rooms (name) VALUES (?)').run(r.name.trim());
  json(res, 200, saveRoom(ins.lastInsertRowid, r));
});
route('PATCH', '/api/rooms/:id', async (req, res, p) => json(res, 200, saveRoom(Number(p.id), await body(req))));
route('DELETE', '/api/rooms/:id', (req, res, p) => {
  q('DELETE FROM rooms WHERE id=?').run(p.id); q('DELETE FROM room_members WHERE room_id=?').run(p.id);
  broadcast('state_changed', {}); json(res, 200, { ok: true });
});

// Runs
route('POST', '/api/runs/:id/stop', (req, res, p) => { stopRun(p.id); json(res, 200, { ok: true }); });

// Approvals (user side)
route('POST', '/api/approvals/:id', async (req, res, p) => {
  const { decision, note, remember } = await body(req);
  const a = q('SELECT * FROM approvals WHERE id=?').get(p.id);
  if (!a || a.status !== 'pending') return json(res, 409, { error: 'Already decided' });
  const status = decision === 'approve' ? 'approved' : 'rejected';
  q('UPDATE approvals SET status=?, note=?, decided_at=unixepoch() WHERE id=?').run(status, note || null, a.id);
  if (remember && status === 'approved') {
    const bot = parseBot(q('SELECT * FROM bots WHERE id=?').get(a.bot_id));
    const input = JSON.parse(a.input || '{}');
    const rule = rememberRule(a.tool, input, remember);
    if (!bot.allow_rules.includes(rule)) saveBot(bot.id, { allow_rules: JSON.stringify([...bot.allow_rules, rule]) });
  }
  const msg = q("SELECT * FROM messages WHERE kind='approval' AND run_id=? AND body LIKE ?").get(a.run_id, `%"approvalId":${a.id},%`);
  if (msg) updateMessage(msg.id, { ...JSON.parse(msg.body), status, note: note || null });
  markTraceWaiting(a.run_id, a.tool, false);

  broadcast('approvals_changed', {});
  json(res, 200, { ok: true });
});

// Redact a message, or just a selected part of it. The text is replaced with [REDACTED] in the chat,
// and the same text is scrubbed from saved prompts, approval requests, other messages and the bots'
// Nimbus checkpoints and action journals. Current native inference sessions are ephemeral;
// historical sessions from before that isolation fix remain recoverable in Codex's archive.
route('POST', '/api/messages/:id/redact', async (req, res, p) => {
  const m = q('SELECT * FROM messages WHERE id=?').get(Number(p.id));
  if (!m) return json(res, 404, { error: 'not found' });
  const { text } = await body(req);
  const secret = String(text || '').trim() || (['text', 'note', 'quiet', 'error'].includes(m.kind) ? m.body.trim() : '');
  if (secret.length < 3) return json(res, 400, { error: ['text', 'note', 'quiet', 'error'].includes(m.kind) ? 'Select at least 3 characters' : 'Select the text to redact in this card first' });
  if (!m.body.includes(secret)) return json(res, 400, { error: 'That text isn’t in this message (formatting can differ: select plain text)' });
  const MASK = '[REDACTED]';
  const like = '%' + secret.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  let changed = 0;
  for (const row of q(`SELECT id, body FROM messages WHERE body LIKE ? ESCAPE '\\'`).all(like)) {
    const esc = JSON.stringify(secret).slice(1, -1); // as it appears inside JSON bodies (traces, approvals)
    const nb = row.body.split(secret).join(MASK).split(esc).join(MASK);
    if (nb !== row.body) { q('UPDATE messages SET body=? WHERE id=?').run(nb, row.id); broadcast('message_update', q('SELECT * FROM messages WHERE id=?').get(row.id)); changed++; }
  }
  for (const [table, col] of [['runs', 'prompt'], ['approvals', 'input']]) {
    for (const row of q(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} LIKE ? ESCAPE '\\'`).all(like)) {
      const esc = JSON.stringify(secret).slice(1, -1);
      q(`UPDATE ${table} SET ${col}=? WHERE id=?`).run(row.v.split(secret).join(MASK).split(esc).join(MASK), row.id);
    }
  }
  let files = 0;
  for(const [table,column,idColumn] of [['runs','checkpoint','id'],['task_events','body','id'],['tool_calls','args','id'],['tool_calls','result','id']]) {
    for(const row of q(`SELECT ${idColumn} AS id,${column} AS value FROM ${table} WHERE ${column} LIKE ? ESCAPE '\\'`).all(like))
      q(`UPDATE ${table} SET ${column}=? WHERE ${idColumn}=?`).run(row.value.split(secret).join(MASK).split(JSON.stringify(secret).slice(1,-1)).join(MASK),row.id);
  }
  for(const row of q('SELECT bot_id,thread,messages FROM worker_history').all()) q('UPDATE worker_history SET messages=? WHERE bot_id=? AND thread=?').run(row.messages.split(secret).join(MASK).split(JSON.stringify(secret).slice(1,-1)).join(MASK),row.bot_id,row.thread);
  json(res, 200, { ok: true, messages: changed, transcripts: files });
});

// Sidebar order the user arranged by dragging (shared by all their devices). null = sort by recent activity.
function readSidebarLayout(){try{return normalizeSidebarLayout(JSON.parse(getSetting('sidebar_layout')||'null'));}catch{return normalizeSidebarLayout(null);}}
route('POST','/api/sidebar/move',async(req,res)=>{
  const input=await body(req);
  try{
    if(input.kind==='group'){
      const current=readSidebarLayout(),group=current.groups.find(group=>group.id===input.id);
      if(!group)throw new Error('Sidebar group not found');
      if(Object.hasOwn(input,'expectedParent')&&input.expectedParent!==group.parent)return json(res,409,{error:'The group moved on another device; refresh and try again'});
      const layout=moveSidebarGroup(current,{id:input.id,parent:input.parent,before:input.before});
      setSetting('sidebar_layout',JSON.stringify(layout));broadcast('state_changed',{});return json(res,200,{sidebarLayout:layout});
    }
    if(input.kind!=='agents')throw new Error('Choose a group or agents to move');
    const ids=input.ids;
    if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(ids).size!==ids.length)throw new Error('Choose valid, unique agent IDs');
    const destination=validateDisplayGroup(input.group),rows=q(`SELECT id,template,display_group FROM bots WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids);
    if(rows.length!==ids.length)throw new Error('An agent was removed; refresh and try again');
    if(rows.some(row=>row.template==='orchestrator'))throw new Error('The root Orchestrator stays above the display groups');
    if(Object.hasOwn(input,'expectedGroup')){
      validateDisplayGroup(input.expectedGroup);
      if(rows.some(row=>row.display_group!==input.expectedGroup))return json(res,409,{error:'An agent moved on another device; refresh and try again'});
    }
    const before=input.before??null,moving=ids.map(id=>'bot:'+id);
    if(before!==null){
      if(typeof before!=='string'||!/^bot:[1-9]\d*$/.test(before)||moving.includes(before))throw new Error('Choose another agent as the insertion point');
      const anchor=q('SELECT display_group,template FROM bots WHERE id=?').get(Number(before.slice(4)));
      if(!anchor||anchor.display_group!==destination||anchor.template==='orchestrator')throw new Error('The insertion point is no longer in that group');
    }
    const known=[...q('SELECT id FROM bots ORDER BY id').all().map(row=>'bot:'+row.id),...q('SELECT id FROM rooms ORDER BY id').all().map(row=>'room:'+row.id)];
    const allowed=new Set(known),stored=normalizeSidebarOrder(JSON.parse(getSetting('side_order')||'null'));
    const order=moveSidebarKeys([...new Set([...normalizeSidebarOrder(input.order),...stored,...known])].filter(key=>allowed.has(key)),moving,before);
    db.exec('SAVEPOINT sidebar_move');
    try{const update=q('UPDATE bots SET display_group=? WHERE id=?');for(const id of ids)update.run(destination,id);setSetting('side_order',JSON.stringify(order));db.exec('RELEASE sidebar_move');}
    catch(error){db.exec('ROLLBACK TO sidebar_move');db.exec('RELEASE sidebar_move');throw error;}
    broadcast('state_changed',{});return json(res,200,{bots:rows.map(row=>({id:row.id,display_group:destination})),sideOrder:order});
  }catch(error){return json(res,400,{error:error.message});}
});
route('PUT', '/api/side-order', async (req, res) => {
  const { order } = await body(req);
  setSetting('side_order', Array.isArray(order) ? JSON.stringify(order.filter((k) => /^(bot|room):\d+$/.test(k)).slice(0, 500)) : '');
  broadcast('state_changed', {});
  json(res, 200, { ok: true });
});

// ---------- portable server settings ----------
const SETTINGS=[{key:'backup_target'}];
route('GET','/api/settings',(req,res)=>json(res,200,Object.fromEntries(SETTINGS.map(s=>[s.key,getSetting(s.key,s.env)]))));
route('PUT','/api/settings',async(req,res)=>{
  const b=await body(req);for(const s of SETTINGS)if(b[s.key]!==undefined)setSetting(s.key,String(b[s.key]));
  broadcast('state_changed',{});json(res,200,{ok:true});
});
route('GET','/api/plan-usage',async(req,res)=>json(res,200,await getPlanUsage()));

// ---------- read aloud (Piper, local text-to-speech) ----------
// Turns a bot reply into speech on this server; nothing leaves the network.
const PIPER_BIN = process.env.NIMBUS_PIPER_BIN || path.join(os.homedir(), 'opt/piper/piper');
const PIPER_VOICE = process.env.NIMBUS_PIPER_VOICE || path.join(os.homedir(), 'opt/piper-voices/en_US-lessac-medium.onnx');
// Markdown and links read badly, so speak plain text.
const speakable = (t) => String(t || '').replace(/```[\s\S]*?```/g, ' (code omitted) ').replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/g, 'a link').replace(/[*_#>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
route('GET', '/api/speak', (req, res) => json(res, 200, { available: fs.existsSync(PIPER_BIN) && fs.existsSync(PIPER_VOICE) }));
route('POST', '/api/speak', async (req, res) => {
  if (!fs.existsSync(PIPER_BIN) || !fs.existsSync(PIPER_VOICE)) return json(res, 503, { error: 'Read-aloud isn’t installed on the server' });
  const { messageId, text } = await body(req);
  const src = messageId ? q('SELECT body FROM messages WHERE id=?').get(Number(messageId))?.body : text;
  const say = speakable(src);
  if (!say) return json(res, 400, { error: 'Nothing to read' });
  const p = spawn(PIPER_BIN, ['--model', PIPER_VOICE, '--output_file', '-'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const chunks = [];
  p.stdout.on('data', (c) => chunks.push(c));
  p.on('error', (e) => { if (!res.headersSent) json(res, 500, { error: e.message }); });
  p.on('close', (code) => {
    if (res.headersSent) return;
    if (code !== 0 || !chunks.length) return json(res, 500, { error: 'Speech failed' });
    const wav = Buffer.concat(chunks);
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'no-store' });
    res.end(wav);
  });
  p.stdin.end(say);
});

// ---------- backups (bin/backup.mjs) ----------
// Nightly at 03:15 local time, plus "Back up now" in Server settings. The last result is kept in settings.
let backupRunning = false;
function runBackup() {
  if (backupRunning) return Promise.resolve(JSON.parse(getSetting('backup_last') || '{}'));
  backupRunning = true;
  return new Promise((resolve) => execFile(process.execPath, ['--no-warnings', path.join(HERE, 'bin/backup.mjs')], { timeout: 30 * 60_000, windowsHide:true }, (err, out) => {
    backupRunning = false;
    let r; try { r = JSON.parse(String(out).trim().split('\n').pop()); } catch { r = { ok: false, error: err?.message || 'backup failed', at: Date.now() }; }
    setSetting('backup_last', JSON.stringify(r));
    if (!r.ok) addMessage('bot:3', 'system', 'note', `⚠ Nightly backup failed: ${r.error}`);
    resolve(r);
  }));
}
setInterval(() => {
  const d = new Date();
  if (d.getHours() === 3 && d.getMinutes() === 15) runBackup();
}, 60_000).unref();
route('GET', '/api/backup', (req, res) => json(res, 200, { last: JSON.parse(getSetting('backup_last') || 'null'), running: backupRunning }));
route('POST', '/api/backup', async (req, res) => json(res, 200, await runBackup()));

// ---------- search, activity log, usage by bot ----------
route('GET', '/api/search', (req, res, _p, url) => {
  const term = String(url.searchParams.get('q') || '').trim();
  if (term.length < 2) return json(res, 200, { results: [] });
  const like = '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const rows = q(`SELECT id, thread, author, body, created_at FROM messages WHERE kind IN ('text','quiet','note') AND body LIKE ? ESCAPE '\\'
    ORDER BY id DESC LIMIT 40`).all(like);
  const low = term.toLowerCase();
  json(res, 200, { results: rows.map((m) => {
    const i = m.body.toLowerCase().indexOf(low), start = Math.max(0, i - 50);
    return { id: m.id, thread: m.thread, author: m.author, at: m.created_at,
      snippet: (start ? '…' : '') + m.body.slice(start, start + 160).replace(/\s+/g, ' ') + (start + 160 < m.body.length ? '…' : '') };
  }) });
});
route('GET', '/api/activity', (req, res, _p, url) => {
  const days = Math.min(90, Number(url.searchParams.get('days') || 7));
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const runs = q(`SELECT id, bot_id, thread, status, started_at, ended_at, cost_usd, effort, parent_run, actual_model, requested_model, route_reason, fallback_reason, backend, input_tokens, output_tokens, last_error, substr(prompt, 1, 160) AS prompt
    FROM runs WHERE started_at >= ? ORDER BY id DESC LIMIT 400`).all(since);
  const approvals = q(`SELECT id, run_id, bot_id, tool, status, note, created_at, decided_at, substr(input, 1, 300) AS input
    FROM approvals WHERE created_at >= ? ORDER BY id DESC LIMIT 400`).all(since);
  json(res, 200, { runs, approvals });
});

// ---------- voice dictation (whisper.cpp) ----------
// Nimbus runs whisper.cpp's server as a child process on localhost only. The browser records 16 kHz
// WAV, so no audio conversion is needed here. Recordings are never written to disk.
const WHISPER_BIN = process.env.NIMBUS_WHISPER_BIN || path.join(os.homedir(), 'opt/whisper.cpp/build/bin/whisper-server');
const WHISPER_MODEL = process.env.NIMBUS_WHISPER_MODEL || path.join(os.homedir(), 'opt/whisper-models/ggml-small.en.bin');
const WHISPER_PORT = Number(process.env.NIMBUS_WHISPER_PORT || 8178);
let whisperProc = null, whisperFails = 0;
function startWhisper() {
  if (!fs.existsSync(WHISPER_BIN) || !fs.existsSync(WHISPER_MODEL)) return;
  whisperProc = spawn(WHISPER_BIN, ['-m', WHISPER_MODEL, '--host', '127.0.0.1', '--port', String(WHISPER_PORT), '-t', String(Math.max(2, os.cpus().length - 2))], { stdio: 'ignore', windowsHide: true });
  whisperProc.on('exit', () => {
    whisperProc = null;
    if (++whisperFails <= 5) setTimeout(startWhisper, 5000 * whisperFails); // crashed: retry with backoff
  });
  setTimeout(() => { whisperFails = 0; }, 60_000).unref();
}
startWhisper();
process.on('exit', () => whisperProc?.kill());
route('GET', '/api/transcribe', (req, res) => json(res, 200, { available: !!whisperProc }));
route('POST', '/api/transcribe', async (req, res) => {
  if (!whisperProc) return json(res, 503, { error: 'Dictation isn’t running on the server' });
  const { audio } = await body(req, 16e6); // ~5 minutes of 16 kHz mono WAV, base64
  const wav = Buffer.from(String(audio || ''), 'base64');
  if (wav.length < 1000 || wav.toString('ascii', 0, 4) !== 'RIFF') return json(res, 400, { error: 'Expected a WAV recording' });
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  try {
    const r = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
    // Whisper marks silence and noise like "[BLANK_AUDIO]" or "(wind blowing)"; drop those.
    const text = String(d.text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    json(res, 200, { text });
  } catch (e) { json(res, 502, { error: 'Transcription failed: ' + e.message }); }
});

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp' };

// ---------- login ----------
// The app is meant to be reachable from the internet, so some login method is required:
// email + password accounts (limited to NIMBUS_ALLOWED_EMAILS), or a single shared NIMBUS_PASSWORD.
const ACCOUNTS = ALLOWED_EMAILS.length > 0;
const AUTH_ON = !!(PASSWORD || ACCOUNTS);
if (!AUTH_ON && process.env.NIMBUS_ALLOW_NO_PASSWORD !== '1') {
  console.error('Set up a login before starting Nimbus: NIMBUS_PASSWORD, or NIMBUS_ALLOWED_EMAILS with locally provisioned accounts. See README.');
  process.exit(1);
}
db.exec('CREATE TABLE IF NOT EXISTS auth_sessions (token TEXT PRIMARY KEY, created_at INTEGER DEFAULT (unixepoch()))');
if (!q('PRAGMA table_info(auth_sessions)').all().some((c) => c.name === 'email')) db.exec("ALTER TABLE auth_sessions ADD COLUMN email TEXT DEFAULT ''");
db.exec('CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, salt TEXT NOT NULL, pw_hash TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()))');
const hashPassword = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
const authKeyFile=path.join(DATA_DIR,'auth-key.dpapi');
if(!fs.existsSync(authKeyFile))fs.writeFileSync(authKeyFile,await protect(crypto.randomBytes(32).toString('hex')),{mode:0o600});
const authKey=Buffer.from(await unprotect(fs.readFileSync(authKeyFile,'utf8')),'hex');
if(authKey.length!==32)throw new Error('Invalid local authentication key');
function credentialBinding(email=''){
  let material;
  if(email){const user=q('SELECT * FROM users WHERE email=?').get(email);if(!ACCOUNTS||!ALLOWED_EMAILS.includes(email)||!user)return null;material=['account',email,user.salt,user.pw_hash,user.totp_enabled||0,user.totp_enabled?user.totp_secret||'':''];}
  else{if(!PASSWORD||ACCOUNTS)return null;material=OWNER_MODE?['username-password-passkey',OWNER_USERNAME.toLowerCase(),PASSWORD,passkeys.version()]:['shared-password',PASSWORD];}
  return crypto.createHmac('sha256',authKey).update(JSON.stringify(material)).digest('hex');
}
const passkeys=OWNER_MODE?new PasskeyStore({db,rpOrigin:PASSKEY_ORIGIN,username:OWNER_USERNAME,binding:()=>credentialBinding('')}):null;
const sessions=new SessionStore({db,binding:credentialBinding});
const throttle=new LoginThrottle({db});
const clientIp=requestIp;
function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}
function cookieToken(req) {
  const t = cookie(req, isHttps(req)?'__Host-nimbus_session':'nimbus_session');
  return t && /^[a-f0-9]{64}$/.test(t) ? t : null;
}
function loggedIn(req) {
  if (!AUTH_ON) return directLocal(req);
  const t = cookieToken(req);
  const row = t && sessions.authenticate(t);
  if (row) {req.user = { email: row.email,...(OWNER_MODE?{username:OWNER_USERNAME}:{}) };req.sessionCreatedAt=row.createdAt;}
  return !!row;
}
function isHttps(req) {
  return secureRequest(req)||process.env.NIMBUS_SECURE_COOKIE==='1';
}
function newSessionCookie(req, email = '') {
  if(!AUTH_ON)return'nimbus_session=; Path=/; Max-Age=0';
  const token = sessions.issue(email),secure=isHttps(req);
  return `${secure?'__Host-nimbus_session':'nimbus_session'}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessions.absoluteSeconds}${secure?'; Secure':''}`;
}
function authLimitsAllowed(res,reservations,message){
  // A globally rejected request never reaches password/factor validation, so
  // it must not consume those smaller budgets and cause a second lockout.
  for(const reserve of reservations){
    const decision=reserve();if(decision.allowed)continue;
    res.setHeader('Retry-After',String(decision.retryAfter));json(res,429,{error:message});return false;
  }
  return true;
}
function reserveSignIn(req,res){
  return authLimitsAllowed(res,[()=>throttle.reserve('global-login',{limit:60,windowSeconds:60}),()=>throttle.reserve('ip:'+clientIp(req))],'Too many sign-in attempts. Try again later.');
}
function reserveFactorRequest(req,res,factor,verify=false){
  const checks=[()=>throttle.reserve('global-login',{limit:60,windowSeconds:60}),()=>throttle.reserve('ip:'+factor+'-requests:'+clientIp(req),{limit:60,windowSeconds:60})];
  // Options retrieval and cancelled native prompts are not password guesses.
  // Actual verification retains its own durable, pre-body eight-attempt limit.
  if(verify)checks.push(()=>throttle.reserve('ip:'+factor+'-factor:'+clientIp(req)));
  return authLimitsAllowed(res,checks,verify?'Too many verification attempts. Try again later.':'Too many authentication requests. Try again later.');
}
function completePassword(req,email){throttle.clear('ip:'+clientIp(req));throttle.clear('identity:'+(OWNER_MODE?OWNER_USERNAME.toLowerCase():email||'shared'));}
function completeSignIn(req,email){
  completePassword(req,email);
  for(const factor of ['passkey','mfa'])throttle.clear('ip:'+factor+'-factor:'+clientIp(req));
  if(email)throttle.clear('mfa:'+email);
}
const LOGIN_PAGE = fs.readFileSync(path.join(PUBLIC, 'login.html'));

route('POST', '/api/login', async (req, res) => {
  if(!reserveSignIn(req,res))return;
  const input=await body(req,16384);
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.password!=='string'||input.password.length>1024||input.email!=null&&typeof input.email!=='string'||input.username!=null&&typeof input.username!=='string'||input.enrollmentToken!=null&&typeof input.enrollmentToken!=='string')return json(res,400,{error:'Invalid sign-in request'});
  const { email: rawEmail, password } = input;
  const email = String(rawEmail || '').trim().toLowerCase();
  if(email.length>320)return json(res,400,{error:'Invalid sign-in request'});
  const username=String(input.username||'').trim().toLowerCase();if(username.length>64||String(input.enrollmentToken||'').length>128)return json(res,400,{error:'Invalid sign-in request'});
  const identity=throttle.reserve('identity:'+(OWNER_MODE?OWNER_USERNAME.toLowerCase():email||'shared'));if(!identity.allowed){res.setHeader('Retry-After',String(identity.retryAfter));return json(res,429,{error:'Too many sign-in attempts. Try again later.'});}
  let ok = false;
  if (ACCOUNTS&&email) {
    const u = q('SELECT * FROM users WHERE email=?').get(email);
    // Hash even for unknown emails so response time doesn't reveal which accounts exist.
    const got = Buffer.from(hashPassword(password || '', u?.salt || 'x'), 'hex');
    ok = !!u && ALLOWED_EMAILS.includes(email) && crypto.timingSafeEqual(got, Buffer.from(u.pw_hash, 'hex'));
  } else if (!ACCOUNTS&&PASSWORD && password) {
    const passwordMatches=crypto.timingSafeEqual(hash(password),hash(PASSWORD));
    ok=passwordMatches&&(!OWNER_MODE||crypto.timingSafeEqual(hash(username),hash(OWNER_USERNAME.toLowerCase())));
  }
  if (!ok) {
    await new Promise((r) => setTimeout(r, 600));
    return json(res, 401, { error: 'Incorrect sign-in details' });
  }
  if(OWNER_MODE&&!passkeyOriginAllowed(req))return json(res,403,{error:'Use '+PASSKEY_ORIGIN+' to sign in with a passkey'});
  // A correct password resets only password counters. It never clears the
  // independent passkey/MFA verification budget or grants an app session.
  completePassword(req,email);
  if(OWNER_MODE){
    let kind='authenticate';
    // Only a never-enrolled owner may create its first key after the password.
    // The durable version closes this path permanently after first enrollment;
    // losing/removing credentials later never reopens password-only enrollment.
    if(passkeys.version()===0&&!passkeys.count())kind='register';
    else if(input.enrollmentToken){if(!passkeys.consumeBootstrap(input.enrollmentToken))return json(res,401,{error:'The owner recovery link expired or was already used. Create a new link on the Nimbus PC.'});kind='register';}
    else if(!passkeys.count())return json(res,403,{error:'Passkey recovery is required. Use an owner recovery link.'});
    const browserToken=crypto.randomBytes(32).toString('hex'),ticket=passkeys.begin({kind,browserToken});
    res.setHeader('set-cookie',preauthCookie(req,browserToken));
    return json(res,200,{passkeyRequired:true,ticket,enrollmentRequired:kind==='register'});
  }
  const acct = email && q('SELECT * FROM users WHERE email=?').get(email);
  if (acct?.totp_enabled) {
    if(!acct.totp_secret)return json(res,401,{error:'Account authentication requires local administrator repair'});
    // Password was right; the session is only issued after the authenticator code.
    const ticket = crypto.randomBytes(24).toString('hex');
    for(const [id,t] of mfaTickets)if(t.until<Date.now())mfaTickets.delete(id);
    mfaTickets.set(ticket, { email, binding:credentialBinding(email),until: Date.now() + 5 * 60_000, tries: 0 });
    return json(res, 200, { mfa: true, ticket });
  }
  completeSignIn(req,email);
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': newSessionCookie(req, email) });
  res.end('{"ok":true}');
});
route('GET', '/api/auth-methods', (req, res) => json(res, 200, { password: !!PASSWORD&&!ACCOUNTS, accounts: ACCOUNTS,signup:false,username:OWNER_MODE,passkeyRequired:OWNER_MODE,passkeyOrigin:OWNER_MODE?PASSKEY_ORIGIN:null }));
route('GET', '/api/https-port', (req, res) => json(res, 200, { port: HTTPS_PORT }));

// Passkeys are the required second factor for the named owner. A password
// success grants only a short-lived ceremony ticket, never an app session.
function passkeyOriginAllowed(req){return OWNER_MODE&&secureRequest(req)&&req.headers.origin===PASSKEY_ORIGIN;}
function preauthName(req){return isHttps(req)?'__Host-nimbus_preauth':'nimbus_preauth';}
function preauthCookie(req,token=''){
  return `${preauthName(req)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token?'300':'0'}${isHttps(req)?'; Secure':''}`;
}
function passkeyBodyValid(input){return input&&typeof input==='object'&&!Array.isArray(input)&&typeof input.ticket==='string'&&/^[a-f0-9]{64}$/.test(input.ticket);}
function passkeyCeremony(req,res,phase='options'){
  if(!passkeys){json(res,404,{error:'Passkeys are not configured'});return false;}
  if(!passkeyOriginAllowed(req)){json(res,403,{error:'Use '+PASSKEY_ORIGIN+' for passkeys'});return false;}
  return phase==='password'?reserveSignIn(req,res):reserveFactorRequest(req,res,'passkey',phase==='verify');
}
function passkeySignedIn(req,res){
  if(!passkeys){json(res,404,{error:'Passkeys are not configured'});return false;}
  if(!loggedIn(req)||Math.floor(Date.now()/1000)-(req.sessionCreatedAt||0)>300){json(res,401,{error:'Sign in again with your password and passkey before managing passkeys'});return false;}
  return true;
}
function passkeyPasswordValid(input){return input&&typeof input.password==='string'&&input.password.length<=1024&&crypto.timingSafeEqual(hash(input.password),hash(PASSWORD));}
route('POST','/api/admin/passkeys/enrollment-ticket',(req,res)=>{
  if(!adminAuth(req))return json(res,403,{error:'Local administration required'});
  if(!passkeys)return json(res,404,{error:'Username and passkey mode is not configured'});
  const token=passkeys.createBootstrap();
  json(res,200,{url:PASSKEY_ORIGIN+'/login?enroll='+token,expiresIn:900,requiresUsernameAndPassword:true});
});
route('GET','/api/passkeys',(req,res)=>json(res,200,passkeys?{available:true,required:true,username:OWNER_USERNAME,origin:PASSKEY_ORIGIN,passkeys:passkeys.list()}:{available:false,required:false,passkeys:[]}));
route('POST','/api/passkeys/enrollment/start',async(req,res)=>{
  if(!passkeyCeremony(req,res,'password'))return;
  const input=await body(req,16384);
  if(!passkeySignedIn(req,res))return;
  if(!passkeyPasswordValid(input))return json(res,401,{error:'Incorrect sign-in details'});
  completePassword(req,'');
  if(input.label!=null&&(typeof input.label!=='string'||input.label.length>80))return json(res,400,{error:'Passkey name must be at most 80 characters'});
  const browserToken=crypto.randomBytes(32).toString('hex'),sessionToken=cookieToken(req);
  const ticket=passkeys.begin({kind:'register',browserToken,label:input.label||'',authorized:()=>Boolean(sessions.authenticate(sessionToken,{touch:false}))});
  res.setHeader('set-cookie',preauthCookie(req,browserToken));json(res,200,{ticket});
});
for(const [kind,name] of [['authenticate','authentication'],['register','registration']]){
  route('POST',`/api/passkeys/${name}/options`,async(req,res)=>{
    if(!passkeyCeremony(req,res))return;
    const input=await body(req,16384);
    if(!passkeyBodyValid(input))return json(res,400,{error:'Invalid passkey request'});
    const browserToken=cookie(req,preauthName(req));
    const options=await (kind==='authenticate'?passkeys.authenticationOptions(input.ticket,browserToken):passkeys.registrationOptions(input.ticket,browserToken));
    json(res,200,options);
  });
  route('POST',`/api/passkeys/${name}/verify`,async(req,res)=>{
    if(!passkeyCeremony(req,res,'verify'))return;
    const input=await body(req,65536);
    if(!passkeyBodyValid(input)||!input.response||typeof input.response!=='object')return json(res,400,{error:'Invalid passkey response'});
    const browserToken=cookie(req,preauthName(req));
    const beforeVersion=passkeys.version();
    const result=await (kind==='authenticate'?passkeys.verifyAuthentication(input.ticket,browserToken,input.response):passkeys.verifyRegistration(input.ticket,browserToken,input.response,{label:input.label}));
    if(!result?.verified)return json(res,401,{error:'Passkey verification failed'});
    if(passkeys.version()!==beforeVersion+(kind==='register'?1:0))return json(res,401,{error:'Passkeys changed during sign-in. Start again.'});
    revalidateClients();completeSignIn(req,'');
    res.setHeader('set-cookie',[newSessionCookie(req,''),preauthCookie(req)]);json(res,200,{ok:true});
  });
}
route('DELETE','/api/passkeys/:id',async(req,res,p)=>{
  if(!passkeyCeremony(req,res,'password'))return;
  const input=await body(req,16384);
  if(!passkeySignedIn(req,res))return;
  if(!passkeyPasswordValid(input))return json(res,401,{error:'Incorrect sign-in details'});
  completePassword(req,'');
  passkeys.remove(p.id);revalidateClients();
  res.setHeader('set-cookie',newSessionCookie(req,''));json(res,200,{ok:true});
});

// Provisioning is restricted to the protected local administrator interface;
// knowing an allowlisted email is never sufficient to claim that identity.
route('POST', '/api/signup', async (req, res) => {
  if(!adminAuth(req))return json(res,403,{error:'Account provisioning is local administration only'});
  if (!ACCOUNTS) return json(res, 404, { error: 'Sign-up is not enabled' });
  const { email: rawEmail, password } = await body(req,16384);
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Enter a valid email' });
  if (typeof password!=='string'||password.length<12||password.length>1024)return json(res,400,{error:'Account password must be 12–1024 characters'});
  if (!ALLOWED_EMAILS.includes(email)) {
    return json(res, 403, { error: "This email isn't allowed to use this Nimbus. Ask the owner to add it to NIMBUS_ALLOWED_EMAILS." });
  }
  if (q('SELECT 1 FROM users WHERE email=?').get(email)) return json(res, 409, { error: 'That email already has an account. Sign in instead.' });
  const salt = crypto.randomBytes(16).toString('hex');
  q('INSERT INTO users (email, salt, pw_hash) VALUES (?,?,?)').run(email, salt, hashPassword(password, salt));
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': newSessionCookie(req, email) });
  res.end('{"ok":true}');
});

// ---------- two-factor (authenticator app codes, RFC 6238 TOTP) ----------
for (const [col, def] of [['totp_secret', "''"], ['totp_enabled', '0'], ['recovery', "'[]'"]]) {
  if (!q('PRAGMA table_info(users)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def === '0' ? 'INTEGER' : 'TEXT'} DEFAULT ${def}`);
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function unbase32(str) {
  let bits = '';
  for (const ch of str.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// Accepts the current 30-second code or its neighbours, to allow for clock drift.
function checkTotp(secret, code) {
  if(typeof secret!=='string'||!/^[A-Z2-7]{16,}$/.test(secret))return false;
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const now = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(totp(secret, now + d)), Buffer.from(code)));
}
// A one-time recovery code is consumed when used.
function useRecoveryCode(user, code) {
  const h = hash(String(code || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')).toString('hex');
  const list = JSON.parse(user.recovery || '[]');
  if (!list.includes(h)) return false;
  q('UPDATE users SET recovery=? WHERE email=?').run(JSON.stringify(list.filter((x) => x !== h)), user.email);
  return true;
}
const mfaTickets = new Map(); // ticket -> { email, until, tries }
function currentUser(req) { return req.user?.email ? q('SELECT * FROM users WHERE email=?').get(req.user.email) : null; }

route('POST', '/api/login/mfa', async (req, res) => {
  if(!reserveFactorRequest(req,res,'mfa',true))return;
  const input=await body(req,16384);if(!input||typeof input.ticket!=='string'||typeof input.code!=='string')return json(res,400,{error:'Invalid verification request'});
  const { ticket, code } = input;
  const t = mfaTickets.get(String(ticket || ''));
  if (!t || t.until < Date.now()) { mfaTickets.delete(ticket); return json(res, 401, { error: 'Sign-in expired. Start again.', restart: true }); }
  const user = q('SELECT * FROM users WHERE email=?').get(t.email);
  if(!user?.totp_enabled||!user.totp_secret||!ALLOWED_EMAILS.includes(t.email)||t.binding!==credentialBinding(t.email)){mfaTickets.delete(ticket);return json(res,401,{error:'Sign-in details changed. Start again.',restart:true});}
  const factorLimit=throttle.reserve('mfa:'+t.email);if(!factorLimit.allowed){res.setHeader('Retry-After',String(factorLimit.retryAfter));return json(res,429,{error:'Too many verification attempts. Try again later.'});}
  const ok = user && (checkTotp(user.totp_secret, code) || useRecoveryCode(user, code));
  if (!ok) {
    if (++t.tries >= 5) { mfaTickets.delete(ticket); return json(res, 401, { error: 'Too many wrong codes. Start again.', restart: true }); }
    await new Promise((r) => setTimeout(r, 600));
    return json(res, 401, { error: 'Wrong code' });
  }
  mfaTickets.delete(ticket);
  completeSignIn(req,t.email);
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': newSessionCookie(req, t.email) });
  res.end('{"ok":true}');
});
route('GET', '/api/mfa', (req, res) => {
  const u = currentUser(req);
  json(res, 200, { available: !!u, enabled: !!u?.totp_enabled, recoveryLeft: u ? JSON.parse(u.recovery || '[]').length : 0 });
});
route('POST', '/api/mfa/setup', (req, res) => {
  const u = currentUser(req);
  if (!u) return json(res, 400, { error: 'Two-factor is for email + password accounts.' });
  if(Math.floor(Date.now()/1000)-(req.sessionCreatedAt||0)>300)return json(res,401,{error:'Sign in again before changing authentication'});
  if (u.totp_enabled) return json(res, 400, { error: 'Two-factor is already on' });
  const secret = base32(crypto.randomBytes(20));
  q('UPDATE users SET totp_secret=? WHERE email=?').run(secret, u.email);
  const uri = `otpauth://totp/Nimbus:${encodeURIComponent(u.email)}?secret=${secret}&issuer=Nimbus&algorithm=SHA1&digits=6&period=30`;
  json(res, 200, { secret, uri });
});
route('POST', '/api/mfa/enable', async (req, res) => {
  const input=await body(req,16384);
  // Recheck after the asynchronous body read: logout or a credential change
  // must not let an in-flight request resurrect an invalidated session.
  if(!loggedIn(req))return json(res,401,{error:'Sign in again before changing authentication'});
  const u = currentUser(req);
  if (!u?.totp_secret) return json(res, 400, { error: 'Start setup first' });
  if(u.totp_enabled)return json(res,400,{error:'Two-factor is already on'});
  if(Math.floor(Date.now()/1000)-(req.sessionCreatedAt||0)>300)return json(res,401,{error:'Sign in again before changing authentication'});
  if (!checkTotp(u.totp_secret, input?.code)) return json(res, 400, { error: 'That code didn’t match. Check your phone’s time is correct and try the newest code.' });
  const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
  q('UPDATE users SET totp_enabled=1, recovery=? WHERE email=?').run(JSON.stringify(codes.map((c) => hash(c).toString('hex'))), u.email);
  revalidateClients();res.setHeader('set-cookie',newSessionCookie(req,u.email));
  json(res, 200, { recovery: codes.map((c) => c.slice(0, 5) + '-' + c.slice(5)) });
});
route('POST', '/api/mfa/disable', async (req, res) => {
  const input=await body(req,16384);
  if(!loggedIn(req))return json(res,401,{error:'Sign in again before changing authentication'});
  const u = currentUser(req);
  if (!u?.totp_enabled) return json(res, 400, { error: 'Two-factor is not on' });
  if(!input||typeof input.password!=='string'||input.password.length>1024||typeof input.code!=='string')return json(res,400,{error:'Wrong password or code'});
  const { password, code } = input;
  const pwOk = crypto.timingSafeEqual(Buffer.from(hashPassword(password || '', u.salt), 'hex'), Buffer.from(u.pw_hash, 'hex'));
  if (!pwOk || !(checkTotp(u.totp_secret, code) || useRecoveryCode(u, code))) return json(res, 400, { error: 'Wrong password or code' });
  q("UPDATE users SET totp_enabled=0, totp_secret='', recovery='[]' WHERE email=?").run(u.email);
  revalidateClients();res.setHeader('set-cookie',newSessionCookie(req,u.email));
  json(res, 200, { ok: true });
});
route('POST', '/api/logout', (req, res) => {
  const t = cookieToken(req);
  if (t) {sessions.revoke(t);revokeClients(t);}
  res.writeHead(200, { 'content-type': 'application/json', 'clear-site-data':'"cache"', 'set-cookie': ['nimbus_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',...(isHttps(req)?['__Host-nimbus_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0']:[]),...(OWNER_MODE?[preauthCookie(req)]:[])] });
  res.end('{"ok":true}');
});

// Local admin access for scripts and bots on this server (bin/nimbus.mjs). The token file is
// readable only by the Nimbus user, and the header is honoured only from localhost.
const ADMIN_TOKEN_FILE = path.join(DATA_DIR, 'admin.token');
if (!fs.existsSync(ADMIN_TOKEN_FILE)) fs.writeFileSync(ADMIN_TOKEN_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const ADMIN_TOKEN = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
function adminAuth(req) {
  const t = String(req.headers['x-nimbus-admin'] || '');
  return t.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ADMIN_TOKEN))
    && directLocal(req);
}

const OPEN_PATHS = new Set(['/health', '/local-login', '/nimbus.webp', '/login', '/api/login', '/api/login/mfa', '/api/auth-methods', '/api/passkeys/authentication/options','/api/passkeys/authentication/verify','/api/passkeys/registration/options','/api/passkeys/registration/verify','/vendor/simplewebauthn-browser.js','/passkeys.js','/icon.svg', '/icon-192.png','/icon-512.png','/apple-touch-icon.png','/offline.html','/sw.js','/pwa.js','/manifest.webmanifest', '/styles.css']);
function checkAuth(req, res, url) {
  if(!AUTH_ON&&!directLocal(req)){json(res,503,{error:'Authentication must be configured before remote access'});return false;}
  if(!directLocal(req)&&!secureRequest(req)){json(res,403,{error:'HTTPS is required'});return false;}
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!sameOriginRequest(req)){json(res,403,{error:'Cross-origin request rejected'});return false;}
  if (OPEN_PATHS.has(url.pathname) || adminAuth(req) || loggedIn(req)) {
    // Mutating API calls must be JSON: blocks form-based cross-site requests.
    if (req.method !== 'GET' && url.pathname.startsWith('/api/') && !String(req.headers['content-type']).includes('application/json')) {
      json(res, 415, { error: 'JSON required' }); return false;
    }
    return true;
  }
  if (url.pathname.startsWith('/api/')) { json(res, 401, { error: 'login required' }); return false; }
  res.writeHead(302, { location: '/login' }); res.end();
  return false;
}

// ---------- bot desktop proxy ----------
// The desktop on the computer VM uses HTTP basic auth, which browsers won't prompt for inside a
// cross-origin iframe. Nimbus serves it at /computer/<botId>/ instead and adds the credentials itself,
// so only someone logged in to Nimbus can see a bot's screen. WebSockets (the live screen) go through too.
async function handle(req, res) {
  try {
    const nonce=crypto.randomBytes(18).toString('base64');
    res.setHeader('x-frame-options','DENY');res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','same-origin');
    res.setHeader('permissions-policy','camera=(), geolocation=(), microphone=(self)');
    res.setHeader('cache-control','no-store');
    res.setHeader('content-security-policy',`default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    if(secureRequest(req))res.setHeader('strict-transport-security','max-age=31536000');
    const url = new URL(req.url, 'http://x');
    if (!checkAuth(req, res, url)) return;
    if (url.pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(LOGIN_PAGE.toString('utf8').replaceAll('<script>',`<script nonce="${nonce}">`)); }
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (m) return await r.fn(req, res, m.groups || {}, url);
    }
    if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    let file = path.join(PUBLIC, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!res.headersSent) json(res, e.statusCode||500, { error: e.statusCode?e.message:'Request could not be completed' });
  }
}
const server = http.createServer(handle);
server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;

// HTTPS on a second port with a self-signed certificate made on first start (data/tls). Browsers only
// allow some features on secure pages: bot desktops (video decoding) and phone notifications need it.
// The certificate covers this server's IPs and hostname, and is remade when they change.
const HTTPS_PORT = Number(process.env.NIMBUS_HTTPS_PORT ?? 0);
function tlsFiles() {
  const dir = path.join(DATA_DIR, 'tls'); fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem'), names = path.join(dir, 'names.txt');
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => i.address);
  const san = ['DNS:localhost', `DNS:${os.hostname()}`, 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
  if (!fs.existsSync(cert) || !fs.existsSync(names) || fs.readFileSync(names, 'utf8') !== san) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-keyout', key, '-out', cert,
      '-subj', '/CN=Nimbus', '-addext', `subjectAltName=${san}`], { stdio: 'ignore', windowsHide: true });
    fs.chmodSync(key, 0o600); fs.writeFileSync(names, san);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}
if (HTTPS_PORT) {
  try {
    const secure = https.createServer(tlsFiles(), handle);
    secure.requestTimeout=30000;secure.headersTimeout=15000;secure.keepAliveTimeout=5000;secure.maxRequestsPerSocket=100;
    secure.on('error', (e) => console.error(`HTTPS not started: ${e.message}`));
    secure.listen(HTTPS_PORT, HOST, () => console.log(`Nimbus HTTPS at https://<this server>:${HTTPS_PORT} (self-signed certificate)`));
  } catch (e) { console.error(`HTTPS not started: ${e.message}`); }
}
server.listen(PORT, HOST, () => {
  maintenance.confirmBoot(bootSourceHash);
  startToolDevelopment(bootSourceHash);
  const shown = ['0.0.0.0', '::'].includes(HOST) ? 'localhost' : HOST;
  console.log(`Nimbus running at http://${shown}:${PORT}${shown !== HOST ? ` (listening on all interfaces, ${HOST})` : ''}`);
});

let closing=false;
async function shutdown(code=0) { if(closing)return;closing=true;server.close();await drainRuntime();await terminals.close();localService?.closeAllConnections();localService?.close();await connectors.close();await browsers.close();db.close();process.exit(code); }
process.on('SIGTERM',()=>shutdown());
process.on('SIGINT',()=>shutdown());
