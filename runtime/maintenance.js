import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { capture } from './process.js';

// Only application source belongs in update snapshots. Runtime state, secrets,
// dependencies and Git metadata are deliberately outside this inventory.
const folders = ['runtime', 'scripts', 'bin', 'public', 'tests', 'docs', 'skills'];
const rootFiles = /^(?:[^.].*\.(?:js|mjs|ps1)|README\.md|AGENTS\.md|package(?:-lock)?\.json|nimbus\.config\.example\.json|\.gitignore)$/i;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.part', file);
}

export class Maintenance {
  constructor({ root, dataDir, requestRestart } = {}) {
    this.root = path.resolve(root); this.data = path.resolve(dataDir);
    this.dir = path.join(this.data, 'updates'); this.requestRestart = requestRestart;
    this.busy = false;
  }
  inventory() {
    const files = {};
    const walk = (dir, nested = false) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
        const file = path.join(dir, entry.name), relative = path.relative(this.root, file).replaceAll('\\', '/');
        if (entry.isSymbolicLink()) throw new Error(`Source symlinks are not supported in updates: ${relative}`);
        if (entry.isDirectory()) { if (nested || folders.includes(entry.name)) walk(file, true); }
        else if (entry.isFile() && (nested || rootFiles.test(entry.name))) files[relative] = digest(fs.readFileSync(file));
      }
    };
    walk(this.root);
    return { files, hash: digest(JSON.stringify(files)) };
  }
  load(id) {
    if (!/^[a-f0-9-]{36}$/.test(String(id))) throw new Error('A valid snapshotId is required');
    const file = path.join(this.dir, id, 'receipt.json');
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (receipt.root !== this.root || receipt.id !== id) throw new Error('Snapshot belongs to another checkout');
    return receipt;
  }
  save(receipt) { writeJSON(path.join(this.dir, receipt.id, 'receipt.json'), receipt); return receipt; }
  pending() {
    const file = path.join(this.dir, 'pending.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }
  status(id) {
    return { root: this.root, dataDir: this.data, sourceHash: this.inventory().hash,
      supervised: this.supervised(), pending: this.pending(), snapshot: id ? this.load(id) : null,
      workflow: 'snapshot before editing; edit source; validate; apply; inspect status after restart' };
  }
  supervised() {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(this.data, 'supervisor.lock'), 'utf8'));
      if (path.resolve(lock.root) !== this.root || lock.pid !== process.ppid) return false;
      process.kill(lock.pid, 0); return true;
    } catch { return false; }
  }
  snapshot() {
    if (this.pending()) throw new Error('An update is already pending');
    const source = this.inventory(), id = randomUUID();
    for (const relative of Object.keys(source.files)) {
      const target = path.join(this.dir, id, 'source', relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(this.root, relative), target);
    }
    if (this.inventory().hash !== source.hash) throw new Error('Source changed while taking the snapshot; retry before editing');
    // Freeze a standalone recovery runner outside application source. Recovery
    // must still work if the candidate breaks maintenance.js or package.json.
    const recovery = path.join(this.dir, id, 'recovery'); fs.mkdirSync(recovery, { recursive: true });
    for (const name of ['maintenance.js','process.js']) fs.copyFileSync(new URL('./'+name,import.meta.url),path.join(recovery,name));
    fs.writeFileSync(path.join(recovery,'package.json'),'{"type":"module"}\n');
    const recoveryScript=path.join(recovery,'restore.mjs');
    fs.writeFileSync(recoveryScript,`import fs from 'node:fs';\nimport path from 'node:path';\nimport {Maintenance} from './maintenance.js';\nconst root=${JSON.stringify(this.root)},dataDir=${JSON.stringify(this.data)};\nfor(const name of ['supervisor.lock','server.pid']){\n const file=path.join(dataDir,name);if(!fs.existsSync(file))continue;\n const value=fs.readFileSync(file,'utf8'),pid=name==='supervisor.lock'?JSON.parse(value).pid:Number(value);\n let alive=false;try{process.kill(pid,0);alive=true;}catch(error){if(error.code==='EPERM')alive=true;}\n if(alive)throw new Error('Stop Nimbus before offline source recovery');\n}\nconst manager=new Maintenance({root,dataDir});manager.failPending('Stopped for offline source recovery');\nconsole.log(JSON.stringify(manager.restore(${JSON.stringify(id)})));\n`);
    return this.save({ id, root: this.root, createdAt: new Date().toISOString(), state: 'snapshot', baseline: source,recoveryScript,
      note: 'Source snapshot includes existing uncommitted edits. Database, credentials, config and worker data are separate.' });
  }
  async validate(id, { signal } = {}) {
    if (this.busy || this.pending()) throw new Error('Another update operation is in progress');
    const receipt = this.load(id), source = this.inventory();
    this.busy = true;
    receipt.state = 'validating'; receipt.candidate = source; receipt.checks = []; delete receipt.error;
    this.save(receipt);
    try {
      const js = Object.keys(source.files).filter(f => /\.(?:mjs|js)$/.test(f));
      for (const file of js) await capture(process.execPath, ['--check', file], { cwd: this.root, signal });
      receipt.checks.push({ name: 'JavaScript syntax', pass: true, files: js.length }); this.save(receipt);
      const tests = Object.keys(source.files).filter(f => /^tests\/.*\.test\.mjs$/.test(f));
      if (!tests.length) throw new Error('No test suite found; refusing an unvalidated update');
      // A validator invoked by a test must start an independent test runner.
      // Node propagates this internal flag and otherwise hides child failures.
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      const output = await capture(process.execPath, ['--no-warnings', '--test', '--test-concurrency=1', ...tests],
        { cwd: this.root, timeout: 180000, signal, env });
      receipt.checks.push({ name: 'Nimbus tests', pass: true, output: output.slice(-12000) });
      signal?.throwIfAborted();
      if (this.inventory().hash !== source.hash) throw new Error('Source changed during validation; validate again');
      receipt.state = 'validated'; receipt.validatedHash = source.hash; receipt.validatedAt = new Date().toISOString();
    } catch (error) {
      if(error.stdout||error.stderr)receipt.checks.push({name:'Failed validation command',pass:false,output:(error.stdout||'').slice(-12000),stderr:(error.stderr||'').slice(-4000),exitCode:error.exitCode});
      receipt.state = 'validation_failed'; receipt.error = error.message; delete receipt.validatedHash;
      this.save(receipt); throw error;
    } finally { this.busy = false; }
    return this.save(receipt);
  }
  apply(id) {
    if (this.busy || this.pending()) throw new Error('Another update operation is in progress');
    const receipt = this.load(id);
    if (receipt.state !== 'validated' || receipt.validatedHash !== this.inventory().hash) throw new Error('Validate the current source before applying');
    if (!this.requestRestart || !this.supervised()) throw new Error('Updates require Start-Nimbus.ps1 and its active supervisor');
    const pending = { snapshotId: id, sourceHash: receipt.validatedHash, oldPid: process.pid, requestedAt: new Date().toISOString() };
    writeJSON(path.join(this.dir, 'pending.json'), pending);
    receipt.state = 'restart_pending'; this.save(receipt);
    try { this.requestRestart(); }
    catch (error) { this.failPending(error.message); throw error; }
    return { snapshotId: id, state: 'restart_pending', note: 'Restart waits for tasks to finish. Inspect self_update status after reconnecting to verify application.' };
  }
  assertPendingSource() {
    const pending = this.pending();
    if (pending && pending.sourceHash !== this.inventory().hash) throw new Error('Source changed after update validation; restart cancelled');
  }
  failPending(error) {
    const pending = this.pending(); if (!pending) return;
    const receipt = this.load(pending.snapshotId); receipt.state = 'restart_failed'; receipt.error = error; this.save(receipt);
    fs.unlinkSync(path.join(this.dir, 'pending.json'));
  }
  confirmBoot(bootHash) {
    const pending = this.pending(); if (!pending || pending.oldPid === process.pid) return;
    if (bootHash !== pending.sourceHash) { this.failPending('Started source does not match the validated update'); return; }
    const receipt = this.load(pending.snapshotId);
    receipt.state = 'applied'; receipt.appliedAt = new Date().toISOString(); receipt.pid = process.pid; receipt.bootHash = bootHash;
    this.save(receipt); fs.unlinkSync(path.join(this.dir, 'pending.json'));
  }
  // Offline recovery only: no running worker may write source during restoration.
  restore(id) {
    const receipt = this.load(id), before = this.inventory();
    if (!receipt.candidate || before.hash !== receipt.candidate.hash) throw new Error('Source differs from this update candidate; preserve and reconcile newer edits before recovery');
    for (const [relative, hash] of Object.entries(receipt.baseline.files)) {
      if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Invalid snapshot path');
      const bytes = fs.readFileSync(path.join(this.dir, id, 'source', relative));
      if (digest(bytes) !== hash) throw new Error(`Corrupt snapshot: ${relative}`);
    }
    // Preserve the failed candidate too, before restoring any bytes.
    const recovery = this.snapshot();
    for (const relative of Object.keys(receipt.baseline.files)) {
      const target = path.join(this.root, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(this.dir, id, 'source', relative), target);
    }
    for (const relative of Object.keys(before.files)) if (!Object.hasOwn(receipt.baseline.files, relative)) fs.unlinkSync(path.join(this.root, relative));
    if (this.inventory().hash !== receipt.baseline.hash) throw new Error('Restored source does not match its snapshot');
    receipt.state = 'source_restored'; receipt.recoverySnapshotId = recovery.id; this.save(receipt);
    return { snapshotId: id, recoverySnapshotId: recovery.id, state: receipt.state, note: 'Source restored. Runtime data and database were not rolled back; verify schema compatibility before restarting.' };
  }
}
