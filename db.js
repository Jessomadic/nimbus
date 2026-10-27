import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {buildWorkerBrief} from './runtime/prompts.js';
import {defaultDisplayGroup} from './public/agent-groups.js';

export const DATA_DIR = path.resolve(process.env.NIMBUS_DATA || './data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'nimbus.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  instructions TEXT DEFAULT '',
  color TEXT DEFAULT '#c9c2f0',
  effort TEXT DEFAULT 'medium',
  model TEXT DEFAULT '',
  approval_rules TEXT DEFAULT '[]',
  allow_rules TEXT DEFAULT '[]',
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  goal TEXT DEFAULT '',
  lead_bot_id INTEGER,
  bots_can_talk INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id INTEGER, bot_id INTEGER, PRIMARY KEY (room_id, bot_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL,
  run_id INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread, id);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER, thread TEXT, status TEXT DEFAULT 'queued',
  prompt TEXT, session_id TEXT, cost_usd REAL DEFAULT 0, effort TEXT,
  started_at INTEGER, ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  bot_id INTEGER, thread TEXT, session_id TEXT, PRIMARY KEY (bot_id, thread)
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER, bot_id INTEGER, thread TEXT, tool TEXT, input TEXT,
  status TEXT DEFAULT 'pending', note TEXT,
  created_at INTEGER DEFAULT (unixepoch()), decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER, cron TEXT, prompt TEXT, enabled INTEGER DEFAULT 1, last_run INTEGER
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS plugins (id TEXT PRIMARY KEY, secrets TEXT DEFAULT '{}', installed_at INTEGER DEFAULT (unixepoch()));
CREATE TABLE IF NOT EXISTS bot_plugins (bot_id INTEGER, plugin_id TEXT, PRIMARY KEY (bot_id, plugin_id));
`);
for (const [col, type] of [['shape', "TEXT DEFAULT 'blob'"], ['template', "TEXT DEFAULT ''"], ['computer', 'INTEGER DEFAULT 0']]) {
  if (!db.prepare('PRAGMA table_info(bots)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE bots ADD COLUMN ${col} ${type}`);
}

export const q = (sql) => db.prepare(sql);
db.exec(`CREATE TABLE IF NOT EXISTS task_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL,
  questions TEXT NOT NULL, answers TEXT, status TEXT DEFAULT 'pending',
  created_at INTEGER DEFAULT (unixepoch())
)`);

export function parseBot(b) {
  if (!b) return b;
  return { ...b, computer: Number(b.computer) ? 1 : 0, approval_rules: JSON.parse(b.approval_rules || '[]'), allow_rules: JSON.parse(b.allow_rules || '[]') };
}

export function botDir(id) {
  const dir = path.join(DATA_DIR, 'bots', String(id));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Each bot gets a workspace folder. AGENTS.md is its standing brief;
// MEMORY.md is what it has learned, which it edits itself.
export function writeBotBrief(bot) {
  const dir = botDir(bot.id);
  const mem = path.join(dir, 'MEMORY.md');
  if (!fs.existsSync(mem)) fs.writeFileSync(mem, `# What ${bot.name} has learned\n\n`);
  const team=q('SELECT id,name,role,parent_bot_id FROM bots WHERE id != ? ORDER BY id').all(bot.id);
  let sharedFacts='';try{sharedFacts=fs.readFileSync(path.join(DATA_DIR,'shared','HOMELAB.md'),'utf8').trim();}catch{}
  fs.writeFileSync(path.join(dir,'AGENTS.md'),buildWorkerBrief({bot,team,sharedFacts,workspace:dir}));
  return dir;
}

// Server settings edited in the app (Settings → Server). Values here override the matching env vars.
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
export function getSetting(key, envName) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : (envName ? process.env[envName] || '' : '');
}
export function setSetting(key, value) {
  if (value === '' || value == null) db.prepare('DELETE FROM settings WHERE key=?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'files')) db.exec("ALTER TABLE messages ADD COLUMN files TEXT DEFAULT '[]'");
if (!db.prepare('PRAGMA table_info(runs)').all().some((c) => c.name === 'parent_run')) db.exec('ALTER TABLE runs ADD COLUMN parent_run INTEGER');
if (!db.prepare('PRAGMA table_info(routines)').all().some((c) => c.name === 'quiet')) db.exec('ALTER TABLE routines ADD COLUMN quiet INTEGER DEFAULT 0');

function addColumns(table, columns) {
  const present = new Set(q(`PRAGMA table_info(${table})`).all().map(c => c.name));
  for (const [name, type] of columns) if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
addColumns('bots', [['runtime', "TEXT DEFAULT 'auto'"], ['default_model',"TEXT DEFAULT ''"], ['parent_bot_id','INTEGER'], ['tools', "TEXT DEFAULT '[\"shell\",\"read_file\",\"write_file\",\"list_files\",\"browser\",\"shared_note\",\"ask_worker\",\"self_update\"]'"]]);
// Seed visual defaults exactly once, atomically with the column addition.
// Later startups must retain explicit groups, including an intentionally empty
// Other-agents selection. Organizational/runtime columns are untouched.
if(!q('PRAGMA table_info(bots)').all().some(column=>column.name==='display_group')){
  db.exec('SAVEPOINT add_display_group');
  try{
    db.exec("ALTER TABLE bots ADD COLUMN display_group TEXT DEFAULT ''");
    const assign=q('UPDATE bots SET display_group=? WHERE id=?');
    for(const bot of q('SELECT id,template FROM bots').all())assign.run(defaultDisplayGroup(bot.template),bot.id);
    db.exec('RELEASE add_display_group');
  }catch(error){db.exec('ROLLBACK TO add_display_group');db.exec('RELEASE add_display_group');throw error;}
}
addColumns('runs', [['requested_model', 'TEXT'], ['actual_model', 'TEXT'], ['route_reason', 'TEXT'], ['fallback_reason', 'TEXT'],
  ['backend', 'TEXT'], ['input_tokens', 'INTEGER DEFAULT 0'], ['output_tokens', 'INTEGER DEFAULT 0'], ['checkpoint', 'TEXT'],
  ['last_error', 'TEXT'], ['source', "TEXT DEFAULT 'user'"], ['quiet', 'INTEGER DEFAULT 0'], ['depth', 'INTEGER DEFAULT 0']]);
addColumns('runs',[['origin_message_id','INTEGER'],['origin_request_id','TEXT']]);
db.exec(`
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS task_events_run ON task_events(run_id,id);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY, run_id INTEGER NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL,
  state TEXT NOT NULL, result TEXT, started_at INTEGER DEFAULT (unixepoch()), ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS worker_history (
  bot_id INTEGER NOT NULL, thread TEXT NOT NULL, messages TEXT NOT NULL, updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY(bot_id,thread)
);
CREATE TABLE IF NOT EXISTS task_requests (
  request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, run_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message_requests (request_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,message_id INTEGER NOT NULL);
`);
