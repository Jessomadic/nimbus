import fs from 'node:fs';
import path from 'node:path';
import { capture } from '../process.js';
import { redact as baseRedact } from '../../redact.js';
const redact = value => baseRedact(String(value).replace(/\b(https?:\/\/)[^/\s@]+@/gi, '$1[credentials]@'));

const text = { type: 'string' };
const count = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const spec = (name, description, properties, required = []) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties, required, additionalProperties: false }
} });
const repo = { repoPath: text };
const paths = { type: 'array', maxItems: 100, items: text };
export const tools = [
  spec('code_search', 'Search source with ripgrep using literal text or a bounded regular expression. Returns exact paths, line numbers and redacted matching lines. Excludes dependencies, Git metadata, build/runtime state and known credential files; use include globs to narrow scope. No shell interpolation.',
    { path: text, query: text, regex: { type: 'boolean' }, caseSensitive: { type: 'boolean' }, include: { type: 'array', maxItems: 20, items: text }, maxResults: count(1, 200) }, ['query']),
  spec('project_map', 'Map a real project directory with file sizes, source-language counts, package entrypoints/scripts and repository instruction paths. Bounded traversal skips symlinks, dependencies and build/runtime state; reports truncation and unreadable paths.',
    { path: text, maxFiles: count(1, 2000), maxDepth: count(1, 12) }),
  spec('dependency_graph', 'Build a bounded static local import graph for JavaScript/TypeScript/Python sources and read declared package dependencies. Reports resolved local edges, external imports and unresolved imports. Static parsing is approximate; dynamic runtime behavior and dependency vulnerability status are not inferred.',
    { path: text, maxFiles: count(1, 1000) }),
  spec('change_impact', 'Trace reverse local import dependencies for proposed changed files. Returns direct/transitive dependents and nearby test candidates from the real project. This is a bounded static impact estimate, not proof of complete test coverage.',
    { path: text, files: paths, maxFiles: count(1, 1000) }, ['files']),
  spec('test_discover', 'Discover test files and configured npm scripts, Python test configuration, and CI workflow files without running them. Reports exact executable test paths and runner hints, including whether inventory limits were reached.',
    { path: text, maxFiles: count(1, 2000) }),
  spec('run_checks', 'Execute a structured repository check through Node test, a named existing npm script, or Python unittest discovery. This runs repository code and may have its side effects; use only within task authority. Returns the real command, exit code, output, timeout/failure evidence and duration. Does not install dependencies or invoke arbitrary shell strings.',
    { path: text, runner: { type: 'string', enum: ['node_test', 'npm_script', 'python_unittest'] }, script: text, files: paths, testDirectory: text, timeoutSeconds: count(1, 180) }, ['runner']),
  spec('security_scan', 'Scan bounded text source for exposed-secret patterns and risky execution/TLS/configuration constructs. Findings contain rule, path and line, never matched secret values. Heuristic candidates require review; this is not a complete security audit or a vulnerability database lookup.',
    { path: text, maxFiles: count(1, 2000), paths }, []),
  spec('git_inspect', 'Read repository identity, branch/HEAD, upstream tracking, dirty paths, recent commits, worktrees and sanitized remote URLs. No fetch, checkout, staging, commit, push or file changes.',
    { ...repo, limit: count(1, 50) }),
  spec('git_diff', 'Inspect a bounded staged, working-tree or two-ref Git diff with file stats and whitespace-check results. External diff/textconv programs are disabled. Paths and refs are separate arguments; no repository state is changed.',
    { ...repo, staged: { type: 'boolean' }, base: text, head: text, paths, contextLines: count(0, 10), maxCharacters: count(1000, 60000) }),
  spec('git_commit_plan', 'Prepare an evidence-backed commit plan for explicitly selected paths. Separates requested changes from unrelated dirty work and currently staged paths, reports whitespace issues and candidate secret findings. It never stages or commits.',
    { ...repo, paths }, ['paths']),
  spec('git_sync_plan', 'Inspect local branch/upstream divergence and optional live remote tip before planning a sync. Does not fetch, pull, merge, rebase, reset or write refs. Local tracking evidence can be stale and is labeled separately from a live remote check.',
    { ...repo, remote: text, branch: text, checkRemote: { type: 'boolean' } }),
  spec('git_push_preflight', 'Inspect an explicit remote and target branch before a separately authorized push. Reads the live remote tip, local HEAD, outgoing range and ancestry when objects are locally available. Never pushes; missing remote objects/protection evidence remain unresolved.',
    { ...repo, remote: text, branch: text }, ['remote', 'branch']),
  spec('github_pr_inspect', 'Use independently authenticated GitHub CLI access to inspect one explicit pull request, exact head/base, merge readiness, reviews and check summary. Read-only. Missing CLI/auth/account access is returned as a setup dependency; no credentials are borrowed from another app.',
    { repository: text, number: count(1, 100000000) }, ['repository', 'number']),
  spec('github_actions_inspect', 'Use independently authenticated GitHub CLI access to inspect one explicit Actions run and its jobs. Optionally read bounded failed-job logs. Reports actual status/conclusion and commit; never dispatches, reruns or cancels a workflow.',
    { repository: text, runId: count(1, Number.MAX_SAFE_INTEGER), failedLogs: { type: 'boolean' }, maxLogCharacters: count(1000, 40000) }, ['repository', 'runId'])
];

export const roleTools = {
  builder: ['code_search', 'project_map', 'run_checks', 'dependency_graph'],
  reviewer: ['git_diff', 'change_impact', 'security_scan', 'code_search'],
  architect: ['project_map', 'dependency_graph', 'change_impact'],
  'qa-engineer': ['test_discover', 'run_checks', 'change_impact'],
  'security-reviewer': ['security_scan', 'dependency_graph', 'git_diff'],
  'github-coordinator': ['git_inspect', 'github_pr_inspect', 'github_actions_inspect'],
  'github-sync': ['git_sync_plan', 'git_inspect'],
  'github-commits': ['git_commit_plan', 'git_diff'],
  'github-push': ['git_push_preflight', 'git_inspect'],
  'github-pull-requests': ['github_pr_inspect', 'git_diff'],
  'github-actions': ['github_actions_inspect', 'test_discover', 'run_checks']
};

const ignored = new Set(['.git', 'node_modules', '.dev', 'data', 'dist', 'build', 'coverage', '.next', '.venv', 'venv', '__pycache__', '.gradle']);
const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.json', '.md', '.yaml', '.yml', '.toml', '.ps1', '.html', '.css', '.sql', '.xml', '.txt', '.sh', '.ini', '.cfg']);
const codeExtensions = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py']);
const slashes = value => value.replaceAll('\\', '/');
const bounded = (value, fallback, max, min = 1) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : fallback));
const at = (ctx, value = '.') => path.resolve(ctx.workspace || ctx.root || process.cwd(), value);
const sensitiveName = name => /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|pfx|p12|token|dpapi))$/i.test(path.basename(name));
function displayedMetadata(value,depth=0){
  if(typeof value==='string')return redact(value);
  if(depth>=20)return'(metadata nesting limit)';
  if(Array.isArray(value))return value.map(item=>displayedMetadata(item,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/^(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)$/i.test(key)?'[REDACTED]':displayedMetadata(item,depth+1)]));
  return value;
}
function inventory(root, { maxFiles = 1000, maxDepth = 12 } = {}) {
  root = path.resolve(root);
  const stat = fs.statSync(root), base = stat.isDirectory() ? root : path.dirname(root);
  const result = { root, base, files: [], unreadable: [], truncated: false, skippedSymlinks: 0 };
  const pending = stat.isDirectory() ? [{ dir: root, depth: 0 }] : [];
  if (stat.isFile()) result.files.push({ path: root, relative: path.basename(root), size: stat.size });
  let visitedDirectories=0;
  while (pending.length) {
    if(++visitedDirectories>5000){result.truncated=true;break;}
    const { dir, depth } = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name)); }
    catch (error) { if (result.unreadable.length < 20) result.unreadable.push({ path: dir, error: error.code }); continue; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { result.skippedSymlinks++; continue; }
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue;
        if (depth >= maxDepth) { result.truncated = true; continue; }
        if (pending.length+visitedDirectories>=5000) { result.truncated=true;continue; }
        pending.push({ dir: file, depth: depth + 1 });
      } else if (entry.isFile()) {
        if (result.files.length >= maxFiles) { result.truncated = true; pending.length=0;break; }
        try { result.files.push({ path: file, relative: slashes(path.relative(base, file)), size: fs.statSync(file).size }); }
        catch (error) { if (result.unreadable.length < 20) result.unreadable.push({ path: file, error: error.code }); }
      }
    }
  }
  result.files.sort((a, b) => a.relative.localeCompare(b.relative));
  return result;
}
function readText(file) {
  if (file.size > 512000) return null;
  try { const bytes = fs.readFileSync(file.path); return bytes.includes(0) ? null : bytes.toString('utf8'); }
  catch(error){file.readError=error.code;return null;}
}
function packageInfo(root, { rawScripts = false } = {}) {
  const file = path.join(root, 'package.json');
  if (!fs.existsSync(file)) return null;
  try {
    if(fs.statSync(file).size>512000)return{path:file,error:'package.json exceeds the 512 KB inspection limit'};
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value))return{path:file,error:'package.json must contain an object'};
    const scripts=Object.fromEntries(Object.entries(value.scripts || {}).map(([key, value]) => [key, rawScripts ? value : typeof value==='string' ? redact(value) : '(invalid non-string script)']));
    const details=displayedMetadata({path:file,name:value.name||null,type:value.type||'commonjs',entrypoint:value.main||null,dependencies:value.dependencies||{},devDependencies:value.devDependencies||{},engines:value.engines||{}});
    return {...details,scripts:rawScripts?scripts:displayedMetadata(scripts)};
  } catch (error) { return { path: file, error: 'package.json cannot be read as a bounded JSON object', code:error.code||'invalid_json' }; }
}
function npmLifecycle(pkg, name) {
  if(typeof name!=='string')return[];
  return [`pre${name}`,name,`post${name}`].filter(script=>Object.hasOwn(pkg?.scripts||{},script)).map(script=>({name:script,body:pkg.scripts[script]}));
}
function validateCheckScript(name, lifecycle) {
  if(!/^(?:test|lint|check|typecheck|validate|verify|build)(?:[:._-][A-Za-z0-9:._-]+)?$/.test(name)||/(?:^|[:._-])(?:publish|deploy|release|install|exec|push|merge)(?:$|[:._-])/.test(name))throw new Error('Only existing test/lint/check/typecheck/validate/verify/build script families are supported');
  for(const script of lifecycle){
    if(typeof script.body!=='string')throw new Error(`The ${script.name} lifecycle script must contain a command string`);
    if(/\b(?:npm|pnpm|yarn)\s+(?:publish|install|add|ci|exec)\b|\bnpx\b|\bgit\s+push\b|\bgh\s+(?:pr\s+merge|release\s+create|workflow\s+run|run\s+rerun)\b|\b(?:deploy|publish)\b/i.test(script.body))throw new Error(`The ${script.name} lifecycle script contains an install, publish, deploy, push or other unsupported external operation; use its dedicated authorized workflow`);
  }
}
// The host can apply existing shell approval rules to the actual configured
// script body as well as the normalized invocation, before this tool executes.
export function policyCommand(name, args = {}, ctx = {}) {
  if(name!=='run_checks')return null;
  const root=at(ctx,args.path);
  if(args.runner==='npm_script'){
    // Decisions use raw configured bodies. The host redacts their display and
    // journal serialization after matching permissions, not before matching.
    const lifecycle=npmLifecycle(packageInfo(root,{rawScripts:true}),args.script);
    return `npm run ${String(args.script||'')} --\nConfigured automatic lifecycle (execution order):\n${lifecycle.length?lifecycle.map(script=>`${script.name}: ${typeof script.body==='string'?script.body:'(invalid non-string script)'}`).join('\n'):'(missing)'}`;
  }
  if(args.runner==='python_unittest')return `python -m unittest discover -s ${path.resolve(root,args.testDirectory||'.')} -v`;
  return `node --test --test-concurrency=1 ${(Array.isArray(args.files)?args.files:[]).slice(0,100).map(file=>path.resolve(root,String(file))).join(' ')}`;
}
function environment() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_PAGER: 'cat', PAGER: 'cat', GH_PROMPT_DISABLED: '1' };
  delete env.NODE_TEST_CONTEXT; delete env.GH_DEBUG;
  return env;
}
async function command(ctx, executable, argv, { cwd, timeout = 20000 } = {}) {
  ctx.signal?.throwIfAborted();
  if (ctx.commandRunner) return ctx.commandRunner(executable, argv, { cwd, timeout, signal: ctx.signal, env: environment() });
  const started = Date.now();
  try {
    const stdout = await capture(executable, argv, { cwd, timeout, signal: ctx.signal, env: environment() });
    return { exitCode: 0, stdout, stderr: '', durationMs: Date.now() - started };
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    return { exitCode: error.exitCode ?? null, stdout: error.stdout || '', stderr: error.stderr || '', error: redact(error.message), durationMs: Date.now() - started, timedOut: /timed out/i.test(error.message) };
  }
}
function success(result, label) {
  if (result.exitCode !== 0) throw new Error(`${label}: ${redact(result.error || result.stderr || result.stdout || 'command failed').slice(-1600)}`);
  return result.stdout;
}
function safeRef(value, label = 'ref') {
  if (typeof value !== 'string' || !value || value.length > 300 || value.startsWith('-') || /[\s\x00-\x1f]/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function safeRemote(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) throw new Error('Use an explicit configured remote name');
  return value;
}
function safeRepository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error('repository must be owner/name');
  return value;
}
function sanitizedRemote(value) {
  let text = value.trim();
  try { const url = new URL(text); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; text = url.toString(); } catch {}
  return redact(text.replace(/\b(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[credentials]@'));
}
async function git(ctx, root, argv, allowFailure = false) {
  const result = await command(ctx, 'git', ['--literal-pathspecs', '-c', 'color.ui=false', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-C', root, ...argv], { cwd: root });
  return allowFailure ? result : success(result, 'Git '+argv[0]);
}
async function gitRoot(args, ctx) {
  const target = at(ctx, args.repoPath || '.');
  return (await git(ctx, target, ['rev-parse', '--show-toplevel'])).trim();
}
function parseStatus(source) {
  const rows = source.split('\0'), result = [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i]) continue;
    const status = rows[i].slice(0, 2), file = rows[i].slice(3), rename = /[RC]/.test(status);
    result.push({ path: file, index: status[0], workingTree: status[1], untracked: status === '??', ...(rename ? { originalPath: rows[++i] } : {}) });
  }
  return result;
}
async function headState(root, ctx) {
  const head = await git(ctx, root, ['rev-parse', '--verify', 'HEAD'], true);
  const branch = await git(ctx, root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
  const upstream = await git(ctx, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], true);
  return { head: head.exitCode === 0 ? head.stdout.trim() : null, branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
    detached: branch.exitCode !== 0, unborn: head.exitCode !== 0, upstream: upstream.exitCode === 0 ? upstream.stdout.trim() : null };
}
function scopedPaths(root, list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 100 || list.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Provide up to 100 nonempty paths');
  return list.map(value => {
    const resolved = path.resolve(root, value), relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw new Error('Selected paths must stay within the repository');
    return slashes(relative);
  });
}
function selected(file, selections) { return !selections.length || selections.some(item => file === item || file.startsWith(item.replace(/\/$/, '')+'/')); }
function staticGraph(root, args = {}) {
  const index = inventory(root, { maxFiles: bounded(args.maxFiles, 500, 1000) });
  const sources = index.files.filter(file => codeExtensions.has(path.extname(file.path)) && !sensitiveName(file.path));
  const files = new Set(index.files.map(file => path.resolve(file.path))), edges = [], external = new Set(), unresolved = [];
  let skippedLargeOrBinary = 0, bytesScanned=0, filesScanned=0;
  for (const file of sources) {
    if(bytesScanned+file.size>8000000){index.truncated=true;break;}
    const source = readText(file); if (source === null) { skippedLargeOrBinary++;if(file.readError)index.unreadable.push({path:file.path,error:file.readError});continue; }
    bytesScanned+=file.size;filesScanned++;
    const expression = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"\r\n]+)['"]|^\s*(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/gm;
    for (const match of source.matchAll(expression)) {
      const imported = match[1] || match[2] || match[3];
      if (edges.length + unresolved.length + external.size >= 4000) { index.truncated = true; break; }
      if (imported.startsWith('.') && path.extname(file.path) !== '.py') {
        const base = path.resolve(path.dirname(file.path), imported);
        const candidates = [base, ...['.js','.mjs','.cjs','.ts','.tsx','.jsx','.json'].map(ext=>base+ext), ...['index.js','index.mjs','index.ts','index.tsx'].map(name=>path.join(base,name))];
        const target = candidates.find(candidate => files.has(candidate));
        if (target) edges.push({ from: file.relative, to: slashes(path.relative(index.base, target)), import: redact(imported) });
        else unresolved.push({ from: file.relative, import: redact(imported) });
      } else if (path.extname(file.path) === '.py' && !imported.startsWith('.')) {
        const candidate = path.join(index.base, imported.replaceAll('.', path.sep)+'.py');
        if (files.has(candidate)) edges.push({ from: file.relative, to: slashes(path.relative(index.base,candidate)), import: redact(imported) });
        else external.add(imported);
      } else external.add(imported);
    }
  }
  return { path: root, files: sources.map(file=>file.relative), edges, external: [...external].sort().map(redact), unresolved, package: packageInfo(index.base), truncated: index.truncated,
    unreadable: index.unreadable.slice(0,20), skippedLargeOrBinary, bytesScanned,filesScanned, limitations: 'Static literal imports only; aliases, language resolvers, generated files and runtime-dependent imports may be unresolved. Inventory excludes dependencies/build/runtime state.' };
}
function discover(root, args = {}) {
  const index = inventory(root, { maxFiles: bounded(args.maxFiles, 1500, 2000) });
  const testFiles = index.files.filter(file => /(?:^|\/)(?:test_[^/]+\.py|[^/]+(?:\.test|\.spec)\.[cm]?[jt]sx?|[^/]+_test\.py)$/.test(file.relative)).map(file=>({path:file.path,relative:file.relative}));
  return { path: root, tests: testFiles, package: packageInfo(index.base), pythonConfiguration: index.files.filter(file=>/^(?:pyproject\.toml|pytest\.ini|setup\.cfg|tox\.ini)$/.test(file.relative)).map(file=>file.path),
    ciWorkflows: index.files.filter(file=>/^\.github\/workflows\/.*\.ya?ml$/.test(file.relative)).map(file=>file.path), truncated:index.truncated, unreadable:index.unreadable };
}
const securityRules = [
  { id:'private-key', severity:'high', regex:/-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, explanation:'Private-key material appears in this file.' },
  { id:'github-token', severity:'high', regex:/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/, explanation:'A GitHub credential-shaped value appears in this file.' },
  { id:'provider-key', severity:'high', regex:/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/, explanation:'A provider credential-shaped value appears in this file.' },
  { id:'hardcoded-secret', severity:'medium', regex:/\b[\w-]*(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|secret)[\w-]*\s*[:=]\s*['"][^'"\r\n]{6,}['"]/i, explanation:'Review this literal credential assignment; examples/placeholders may be false positives.' },
  { id:'environment-secret',severity:'medium',regex:/^\s*[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY)[A-Z0-9_]*\s*=\s*(?!\$|\{)[^\s#]{6,}/,explanation:'Review this environment credential assignment; values are withheld and placeholders may be false positives.' },
  { id:'tls-verification-disabled', severity:'high', regex:/NODE_TLS_REJECT_UNAUTHORIZED['"]?\s*\]?\s*[:=]\s*['"]?0|rejectUnauthorized\s*:\s*false|verify\s*=\s*False/, explanation:'TLS verification may be disabled here.' },
  { id:'dynamic-evaluation', severity:'medium', regex:/\beval\s*\(|\bnew\s+Function\s*\(/, explanation:'Dynamic code evaluation requires input/control-flow review.' },
  { id:'shell-string-execution', severity:'medium', regex:/\b(?:exec|execSync)\s*\(|shell\s*:\s*true/, explanation:'Review shell-string execution and input handling; this is not proof of injection.' },
  { id:'download-and-execute', severity:'high', regex:/\b(?:curl|wget)\b[^\r\n]*\|\s*(?:bash|sh|powershell|iex)\b|Invoke-Expression\s*\(/i, explanation:'Review this downloaded/dynamic execution path before running it.' }
];
function scan(root, args = {}) {
  const index = inventory(root, { maxFiles: bounded(args.maxFiles, 1000, 2000) });
  const selection = scopedPaths(index.base, args.paths), findings = []; let filesScanned = 0, bytesScanned = 0, skippedLargeOrBinary = 0;
  scanFiles:for (const file of index.files) {
    if (!selected(file.relative, selection) || !sourceExtensions.has(path.extname(file.path)) && !sensitiveName(file.path)) continue;
    if (bytesScanned + file.size > 8000000) { index.truncated = true; break; }
    const source = readText(file); if (source === null) { skippedLargeOrBinary++;if(file.readError)index.unreadable.push({path:file.path,error:file.readError});continue; }
    filesScanned++; bytesScanned += file.size;
    for (const [lineIndex,line] of source.split(/\r?\n/).entries()) for (const rule of securityRules) if (rule.regex.test(line)) {
      if (findings.length >= 300) { index.truncated = true; break scanFiles; }
      findings.push({path:file.path,relative:file.relative,line:lineIndex+1,rule:rule.id,severity:rule.severity,explanation:rule.explanation,confidence:'heuristic'});
    }
  }
  return {path:root,filesScanned,bytesScanned,findings,truncated:index.truncated,skippedLargeOrBinary,unreadable:index.unreadable.slice(0,20),
    note:'Matched values and source excerpts are intentionally omitted. Review findings in context; absence of these patterns does not establish security. No dependency vulnerability database was queried.'};
}
async function diff(root, args, ctx) {
  const selections=scopedPaths(root,args.paths),argv=['diff','--no-ext-diff','--no-textconv','--no-color','--no-renames'];
  if(args.staged)argv.push('--cached');
  if(args.base)argv.push(safeRef(args.base));if(args.head){if(!args.base)throw new Error('head requires base');argv.push(safeRef(args.head));}
  const suffix=['--',...selections];
  const raw=await git(ctx,root,[...argv,`--unified=${bounded(args.contextLines,3,10,0)}`,...suffix]);
  const stat=await git(ctx,root,[...argv,'--numstat','-z',...suffix]);
  const check=await git(ctx,root,[...argv,'--check',...suffix],true);
  const max=bounded(args.maxCharacters,30000,60000,1000);
  const statRows=stat.split('\0',501).filter(Boolean);
  return {path:root,scope:args.base?'refs':args.staged?'staged':'working_tree',base:args.base||null,head:args.head||null,
    files:statRows.slice(0,500).map(row=>{const [added,deleted,...file]=row.split('\t');return{path:file.join('\t'),added:added==='-'?null:Number(added),deleted:deleted==='-'?null:Number(deleted),binary:added==='-'};}),
    patch:redact(raw.slice(0,max)),truncated:raw.length>max||statRows.length>500,whitespace:{pass:check.exitCode===0,exitCode:check.exitCode,output:redact((check.stdout||check.stderr||check.error||'').slice(0,8000))}};
}
async function remoteTip(root, remote, branch, ctx, { push = false } = {}) {
  safeRemote(remote);safeRef(branch,'branch');
  success(await git(ctx,root,['check-ref-format','--branch',branch],true),'Invalid branch');
  const destination=(await git(ctx,root,['remote','get-url',...(push?['--push']:[]),remote])).trim();
  if(destination.startsWith('-')||/^[A-Za-z][A-Za-z0-9+.-]*::/.test(destination)||/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(destination)&&! /^(?:https?|ssh|git|file):\/\//i.test(destination))throw new Error('Unsupported remote helper/transport; inspect the destination with git_inspect first');
  const result=await git(ctx,root,['ls-remote','--heads',destination,'refs/heads/'+branch],true);
  if(result.exitCode!==0)return{verified:false,error:redact(result.error||result.stderr||'Remote tip could not be read')};
  const row=result.stdout.split(/\r?\n/).find(line=>line.split('\t')[1]==='refs/heads/'+branch);
  return{verified:true,sha:row?row.split('\t')[0]:null,newBranch:!row};
}

export async function execute(name, args = {}, ctx = {}) {
  ctx.signal?.throwIfAborted();
  if(name==='code_search'){
    if(typeof args.query!=='string'||!args.query||args.query.length>2000)throw new Error('query must contain 1 to 2000 characters');
    const root=at(ctx,args.path),rootStat=fs.statSync(root),scope=path.resolve(ctx.workspace||ctx.root||process.cwd()),relative=path.relative(scope,root);
    const scopeParts=(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)?root:relative).split(/[\\/]+/);
    if(rootStat.isFile()&&sensitiveName(root)||scopeParts.some(part=>['.git','node_modules','.venv','venv','.gradle'].includes(part)))throw new Error('code_search excludes known credential files and Git/dependency metadata, including explicit file targets');
    const limit=bounded(args.maxResults,50,200),argv=['--json','--line-number','--hidden','--max-count',String(limit),'--max-columns','1000','--max-columns-preview'];
    if(!args.regex)argv.push('--fixed-strings');if(!args.caseSensitive)argv.push('--ignore-case');
    if(args.include!==undefined&&(!Array.isArray(args.include)||args.include.length>20||args.include.some(g=>typeof g!=='string'||g.length>300)))throw new Error('Invalid include globs');
    for(const glob of args.include||[])argv.push('--glob',glob);
    // Later rg glob rules win, so safety exclusions follow caller includes.
    for(const dir of ignored)argv.push('--glob','!**/'+dir+'/**');
    for(const glob of ['!**/.env*','!**/*.pem','!**/*.key','!**/credentials*','!**/secrets*'])argv.push('--glob',glob);
    argv.push('--',args.query,root);
    const result=await command(ctx,'rg',argv,{cwd:rootStat.isDirectory()?root:path.dirname(root),timeout:15000});
    if(![0,1].includes(result.exitCode))return{available:result.exitCode!==null,path:root,dependency:'ripgrep (rg)',error:result.error||redact(result.stderr),matches:[]};
    const matches=[];let truncated=false;
    for(const line of result.stdout.split(/\r?\n/)){
      if(!line)continue;
      let row;try{row=JSON.parse(line);}catch{truncated=true;continue;}
      if(row.type!=='match')continue;
      if(matches.length>=limit){truncated=true;continue;}
      matches.push({path:row.data.path.text||Buffer.from(row.data.path.bytes,'base64').toString(),line:row.data.line_number,text:redact(row.data.lines.text||'').slice(0,2000)});
    }
    return{available:true,path:root,query:args.query,matches,truncated,exitCode:result.exitCode,note:'Dependency/build/runtime state and known credential files were excluded.'};
  }
  if(name==='project_map'){
    const index=inventory(at(ctx,args.path),{maxFiles:bounded(args.maxFiles,1000,2000),maxDepth:bounded(args.maxDepth,8,12)}),languages={};
    for(const file of index.files){const ext=path.extname(file.path)||'(no extension)';languages[ext]=(languages[ext]||0)+1;}
    return{path:index.root,files:index.files.map(f=>({path:f.path,relative:f.relative,bytes:f.size})),languages,totalBytes:index.files.reduce((n,f)=>n+f.size,0),package:packageInfo(index.base),
      instructions:index.files.filter(f=>/(?:^|\/)(?:AGENTS\.md|CONTRIBUTING(?:\.md)?|README(?:\.md)?)$/i.test(f.relative)).map(f=>f.path),truncated:index.truncated,unreadable:index.unreadable,skippedSymlinks:index.skippedSymlinks};
  }
  if(name==='dependency_graph')return staticGraph(at(ctx,args.path),args);
  if(name==='change_impact'){
    const root=at(ctx,args.path),graph=staticGraph(root,args),changes=scopedPaths(root,args.files);
    if(!changes.length)throw new Error('Provide at least one changed file');
    const direct=graph.edges.filter(e=>changes.includes(e.to)).map(e=>e.from),impacted=new Set(changes),queue=[...changes];
    while(queue.length){const target=queue.shift();for(const edge of graph.edges)if(edge.to===target&&!impacted.has(edge.from)){impacted.add(edge.from);queue.push(edge.from);}}
    const testCandidates=discover(root,args).tests.filter(f=>impacted.has(f.relative)||changes.some(change=>path.basename(f.relative).includes(path.basename(change,path.extname(change)))));
    return{path:root,changedFiles:changes,directDependents:[...new Set(direct)],transitiveDependents:[...impacted].filter(f=>!changes.includes(f)),testCandidates,truncated:graph.truncated,limitations:graph.limitations};
  }
  if(name==='test_discover')return discover(at(ctx,args.path),args);
  if(name==='security_scan')return scan(at(ctx,args.path),args);
  if(name==='run_checks'){
    const root=at(ctx,args.path);let executable,argv;
    if(args.runner==='node_test'){
      const files=args.files?.length?scopedPaths(root,args.files).map(f=>path.join(root,f)):discover(root).tests.filter(f=>/\.test\.[cm]?js$/.test(f.path)).map(f=>f.path);
      if(!files.length)throw new Error('No Node test files found; provide explicit files or use a configured npm script');
      if(files.some(file=>!fs.existsSync(file)))throw new Error('A selected test file does not exist');
      executable=process.execPath;argv=['--no-warnings','--test','--test-concurrency=1',...files];
    }else if(args.runner==='npm_script'){
      const pkg=packageInfo(root,{rawScripts:true});if(!pkg?.scripts||typeof args.script!=='string'||!Object.hasOwn(pkg.scripts,args.script))throw new Error('Select a script that exists in this package.json');
      validateCheckScript(args.script,npmLifecycle(pkg,args.script));
      const cli=path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
      if(!fs.existsSync(cli))return{available:false,dependency:'Node npm-cli.js',path:root,error:'Cannot locate npm next to this Node runtime; use node_test or configure the runtime.'};
      executable=process.execPath;argv=[cli,'run',args.script,'--'];
    }else if(args.runner==='python_unittest'){
      const directory=path.resolve(root,args.testDirectory||'.'),relative=path.relative(root,directory);
      if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('testDirectory must stay in the project');
      executable=process.platform==='win32'?'python.exe':'python3';argv=['-m','unittest','discover','-s',directory,'-v'];
    }else throw new Error('Choose node_test, npm_script or python_unittest');
    const result=await command(ctx,executable,argv,{cwd:root,timeout:bounded(args.timeoutSeconds,120,180)*1000});
    return{path:root,runner:args.runner,command:{executable,args:argv},pass:result.exitCode===0&&!result.timedOut,exitCode:result.exitCode,durationMs:result.durationMs,
      stdout:redact(result.stdout.slice(-40000)),stderr:redact(result.stderr.slice(-12000)),...(result.error?{error:result.error}:{}),timedOut:!!result.timedOut,truncated:result.stdout.length>40000||result.stderr.length>12000};
  }
  if(name.startsWith('git_')){
    const root=await gitRoot(args,ctx),state=await headState(root,ctx);
    if(name==='git_inspect'){
      const status=parseStatus(await git(ctx,root,['status','--porcelain=v1','-z','--untracked-files=normal']));
      const remoteNames=(await git(ctx,root,['remote'])).split(/\r?\n/).filter(Boolean),remotes=[];
      for(const name of remoteNames.slice(0,20)){const urls=await git(ctx,root,['remote','get-url','--all',name],true);remotes.push({name,urls:urls.exitCode===0?urls.stdout.trim().split(/\r?\n/).map(sanitizedRemote):[]});}
      const log=state.head?await git(ctx,root,['log',`--max-count=${bounded(args.limit,10,50)}`,'--format=%H%x09%aI%x09%s']):'';
      const worktrees=await git(ctx,root,['worktree','list','--porcelain']);
      return{path:root,...state,dirty:status.length>0,changes:status.slice(0,300),changesTruncated:status.length>300,remotes,
        recentCommits:log.trim().split(/\r?\n/).filter(Boolean).map(line=>{const [sha,date,...subject]=line.split('\t');return{sha,date,subject:redact(subject.join('\t'))};}),worktrees:redact(worktrees.slice(0,12000))};
    }
    if(name==='git_diff')return diff(root,args,ctx);
    if(name==='git_commit_plan'){
      const selections=scopedPaths(root,args.paths);if(!selections.length)throw new Error('Choose explicit paths for this commit plan');
      const status=parseStatus(await git(ctx,root,['status','--porcelain=v1','-z','--untracked-files=all']));
      const staged=await diff(root,{staged:true,paths:selections,maxCharacters:10000},ctx),unstaged=await diff(root,{paths:selections,maxCharacters:10000},ctx);
      const selectedChanges=status.filter(row=>selected(row.path,selections)),unrelatedChanges=status.filter(row=>!selected(row.path,selections)),stagedChanges=status.filter(row=>row.index!==' '&&row.index!=='?');
      return{path:root,...state,requestedPaths:selections,selectedChanges:selectedChanges.slice(0,300),unrelatedChanges:unrelatedChanges.slice(0,200),
        stagedChanges:stagedChanges.slice(0,300),changesTruncated:selectedChanges.length>300||unrelatedChanges.length>200||stagedChanges.length>300,staged,unstaged,security:scan(root,{paths:selections,maxFiles:1000}),performedChanges:false,
        note:'Review selected/untracked content and staged unrelated paths before an authorized commit. This plan has not modified the index or committed anything.'};
    }
    if(name==='git_sync_plan'){
      let divergence=null,divergenceError=null;
      if(state.upstream&&state.head){const result=await git(ctx,root,['rev-list','--left-right','--count','HEAD...'+safeRef(state.upstream)],true);if(result.exitCode===0){const [ahead,behind]=result.stdout.trim().split(/\s+/).map(Number);divergence={ahead,behind,evidence:'local_tracking_ref'};}else divergenceError=redact(result.error||result.stderr||'Could not establish branch divergence');}
      let remote=args.remote,branch=args.branch;
      if(state.branch){if(!remote){const r=await git(ctx,root,['config','--get',`branch.${state.branch}.remote`],true);if(r.exitCode===0)remote=r.stdout.trim();}if(!branch){const r=await git(ctx,root,['config','--get',`branch.${state.branch}.merge`],true);if(r.exitCode===0)branch=r.stdout.trim().replace(/^refs\/heads\//,'');}}
      if(args.checkRemote&&(!remote||!branch))throw new Error('Live remote inspection requires explicit remote/branch or a configured branch upstream');
      const liveRemote=args.checkRemote?await remoteTip(root,safeRemote(remote),safeRef(branch,'branch'),ctx):null;
      return{path:root,...state,remote:remote||null,targetBranch:branch||null,divergence,divergenceError,liveRemote,performedChanges:false,
        recommendation:!state.upstream?'Configure the intended upstream before choosing a sync operation.':!divergence?'Could not establish local/upstream divergence; inspect the recorded error and branch state before choosing a sync operation.':divergence.ahead&&divergence.behind?'Branches diverged; inspect commits and choose a user-authorized integration strategy.':divergence.behind?'Inspect incoming commits before an authorized fast-forward or other integration.':divergence.ahead?'Local commits are ahead of the tracking ref; inspect a push preflight if pushing is authorized.':'No local tracking divergence observed.',
        note:'No fetch was performed. Local upstream counts can be stale; a live tip alone does not download its commit objects.'};
    }
    if(name==='git_push_preflight'){
      const remote=safeRemote(args.remote),branch=safeRef(args.branch,'branch');
      const pushUrls=(await git(ctx,root,['remote','get-url','--push','--all',remote])).trim().split(/\r?\n/).filter(Boolean);
      const remoteUrl=sanitizedRemote(pushUrls[0]||'');
      const tip=await remoteTip(root,remote,branch,ctx,{push:true});let ancestry=null,outgoingCount=null,outgoingCommits=[];
      if(tip.verified&&state.head){
        let range='HEAD';
        if(tip.sha){const known=await git(ctx,root,['cat-file','-e',tip.sha+'^{commit}'],true);if(known.exitCode===0){const ancestor=await git(ctx,root,['merge-base','--is-ancestor',tip.sha,'HEAD'],true);ancestry=ancestor.exitCode===0;range=tip.sha+'..HEAD';}else range=null;}
        else ancestry=true;
        if(range){outgoingCount=Number((await git(ctx,root,['rev-list','--count',range])).trim());const raw=await git(ctx,root,['log','--max-count=50','--format=%H%x09%s',range]);outgoingCommits=raw.trim().split(/\r?\n/).filter(Boolean).map(line=>{const [sha,...subject]=line.split('\t');return{sha,subject:redact(subject.join('\t'))};});}
      }
      return{path:root,...state,remote,remoteUrl,pushDestinations:pushUrls.map(sanitizedRemote),targetBranch:branch,remoteTip:tip,remoteIsAncestor:ancestry,outgoingCount,outgoingCommits,
        fastForwardPossible:pushUrls.length===1&&tip.verified&&!!state.head&&ancestry===true,protectionStatus:'not_checked',performedPush:false,
        unresolved:[...(pushUrls.length>1?['This remote has multiple push destinations; only the first destination tip was inspected.']:[]),...(!tip.verified?['Live remote tip could not be verified.']:[]),...(tip.sha&&ancestry===null?['Remote commit objects are missing locally; ancestry/outgoing range cannot be established without separately authorized synchronization.']:[]),...(ancestry===false?['Remote tip is not an ancestor of local HEAD; a normal fast-forward push may fail.']:[]),'Branch protections, required reviews and deployment side effects are not checked by this local preflight.'],
        note:'This tool never pushes and does not authorize a push. Inspect the exact outgoing range and user-authorized destination.'};
    }
  }
  if(name==='github_pr_inspect'||name==='github_actions_inspect'){
    const repository=safeRepository(args.repository);let argv;
    if(name==='github_pr_inspect'){
      if(!Number.isSafeInteger(args.number)||args.number<1)throw new Error('A positive PR number is required');
      argv=['pr','view',String(args.number),'--repo',repository,'--json','number,title,state,isDraft,headRefName,headRefOid,baseRefName,url,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,changedFiles,additions,deletions,author'];
    }else{
      if(!Number.isSafeInteger(args.runId)||args.runId<1)throw new Error('A positive Actions runId is required');
      argv=['run','view',String(args.runId),'--repo',repository,'--json','databaseId,name,workflowName,event,headBranch,headSha,status,conclusion,url,createdAt,updatedAt,jobs'];
    }
    const result=await command(ctx,'gh',argv,{cwd:ctx.workspace||ctx.root||process.cwd(),timeout:45000});
    if(result.exitCode!==0)return{available:false,repository,dependency:'Independently authenticated GitHub CLI (gh)',mode:'read_only',error:result.error||redact(result.stderr||result.stdout).slice(-3000)};
    let record;try{record=JSON.parse(result.stdout);}catch{throw new Error('GitHub CLI returned invalid JSON');}
    const bounds={};
    if(Array.isArray(record.statusCheckRollup)){bounds.totalChecks=record.statusCheckRollup.length;bounds.checksTruncated=record.statusCheckRollup.length>100;record.statusCheckRollup=record.statusCheckRollup.slice(0,100);}
    if(Array.isArray(record.jobs)){
      bounds.totalJobs=record.jobs.length;bounds.jobsTruncated=record.jobs.length>50;
      record.jobs=record.jobs.slice(0,50).map(job=>{const{steps,...details}=job;return{...details,totalSteps:Array.isArray(steps)?steps.length:0,failedSteps:Array.isArray(steps)?steps.filter(step=>step.conclusion==='failure'||step.status==='in_progress').slice(0,20):[]};});
    }
    const output={available:true,repository,mode:'read_only',verification:'GitHub CLI API response',record,bounds};
    if(name==='github_actions_inspect'&&args.failedLogs){
      const logs=await command(ctx,'gh',['run','view',String(args.runId),'--repo',repository,'--log-failed'],{cwd:ctx.workspace||ctx.root||process.cwd(),timeout:45000});
      const limit=bounded(args.maxLogCharacters,16000,40000,1000);output.failedLogs={available:logs.exitCode===0,output:redact(logs.stdout.slice(-limit)),truncated:logs.stdout.length>limit,...(logs.error?{error:logs.error}:{})};
    }
    return output;
  }
  throw new Error(`Unknown engineering tool: ${name}`);
}
