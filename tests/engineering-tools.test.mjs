import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture } from '../runtime/process.js';
import { execute, tools, roleTools, policyCommand } from '../runtime/toolsets/engineering.js';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-engineering-test-'));
  const write=(file,value)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),value);};
  const ctx={workspace:root,root,dataDir:path.join(root,'data')};
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^nimbus-engineering-test-/);fs.rmSync(root,{recursive:true,force:true});});
  return{root,write,ctx};
}
async function git(root,...args){return capture('git',['-C',root,...args],{env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}});}
async function repository(t){
  const fixtureValue=fixture(t),{root,write}=fixtureValue;
  await git(root,'init','-b','main');await git(root,'config','user.email','fixture@example.invalid');await git(root,'config','user.name','Nimbus Fixture');
  write('alpha.txt','baseline\n');write('package.json','{"name":"engineering-fixture","type":"module","scripts":{"test":"node --test tests/*.test.mjs"}}');
  await git(root,'add','alpha.txt','package.json');await git(root,'commit','-m','Fixture baseline');return fixtureValue;
}

test('engineering registry has unique schemas and gives every engineering/GitHub role a specialist',()=>{
  const names=tools.map(tool=>tool.function.name);assert.equal(names.length,14);assert.equal(new Set(names).size,names.length);
  for(const tool of tools)assert.equal(tool.function.parameters.additionalProperties,false);
  for(const role of ['builder','reviewer','architect','qa-engineer','security-reviewer','github-coordinator','github-sync','github-commits','github-push','github-pull-requests','github-actions']){
    assert.ok(roleTools[role]?.length,role);assert.ok(roleTools[role].every(name=>names.includes(name)));
  }
});
test('project map inventories real instructions/package details and reports inventory truncation',async t=>{
  const {root,write,ctx}=fixture(t);write('AGENTS.md','Project rules');write('src/main.js','export const value=1;');write('package.json',JSON.stringify({name:'map-fixture',scripts:{test:'node --test'},dependencies:{private:'https://fixture-user:fixture-pass@registry.invalid/private.tgz'},devDependencies:{nested:{password:'nested-fixture-password'}}}));write('node_modules/ignored.js','excluded');
  const result=await execute('project_map',{},ctx);assert.equal(result.package.name,'map-fixture');assert.ok(result.instructions.includes(path.join(root,'AGENTS.md')));assert.equal(result.languages['.js'],1);assert.equal(result.files.some(f=>f.relative.includes('node_modules')),false);
  assert.equal(JSON.stringify(result.package).includes('fixture-pass'),false);assert.equal(JSON.stringify(result.package).includes('fixture-user'),false);assert.equal(JSON.stringify(result.package).includes('nested-fixture-password'),false);
  assert.equal((await execute('project_map',{maxFiles:1},ctx)).truncated,true);
});
test('code search finds literal source lines, excludes credentials/dependencies and distinguishes a bad pattern',async t=>{
  const {write,ctx}=fixture(t);write('src/a.js','export const unusualLiteral = "alpha.beta";\n');write('deep/node_modules/ignore.js','alpha.beta');write('.env','SECRET=alpha.beta');
  const found=await execute('code_search',{query:'alpha.beta',include:['*.js']},ctx);assert.equal(found.available,true);assert.equal(found.matches.length,1);assert.equal(found.matches[0].line,1);assert.match(found.matches[0].path,/a\.js$/);
  const absent=await execute('code_search',{query:'NEVER_IN_FIXTURE'},ctx);assert.equal(absent.available,true);assert.equal(absent.exitCode,1);assert.deepEqual(absent.matches,[]);
  const invalid=await execute('code_search',{query:'[',regex:true},ctx);assert.equal(invalid.available,true);assert.ok(invalid.error);
  await assert.rejects(execute('code_search',{query:'alpha.beta',path:'.env'},ctx),/credential files/);
  await assert.rejects(execute('code_search',{query:'alpha.beta',path:'deep/node_modules/ignore.js'},ctx),/Git\/dependency metadata/);
  write('data/verification/project/sample.js','SCOPED_PROJECT_OK');
  const explicit=await execute('code_search',{query:'SCOPED_PROJECT_OK',path:'data/verification/project'},ctx);assert.equal(explicit.matches.length,1);
});
test('static dependencies and reverse impact follow real local imports and retain unresolved evidence',async t=>{
  const {write,ctx}=fixture(t);write('package.json','{"type":"module","dependencies":{"some-lib":"1.0.0"}}');
  write('src/value.js','export const value=1;');write('src/api.js',"import {value} from './value.js'; import {missing} from './absent.js'; export const result=value;");write('src/main.js',"import {result} from './api.js'; import os from 'node:os'; import remote from 'https://fixture-user:fixture-pass@example.invalid/module.js';");write('tests/value.test.mjs',"import {value} from '../src/value.js';");
  const graph=await execute('dependency_graph',{},ctx);assert.ok(graph.edges.some(e=>e.from==='src/main.js'&&e.to==='src/api.js'));assert.ok(graph.external.includes('node:os'));assert.deepEqual(graph.unresolved,[{from:'src/api.js',import:'./absent.js'}]);
  assert.equal(JSON.stringify(graph).includes('fixture-user'),false);assert.equal(JSON.stringify(graph).includes('fixture-pass'),false);
  const impact=await execute('change_impact',{files:['src/value.js']},ctx);assert.ok(impact.directDependents.includes('src/api.js'));assert.ok(impact.transitiveDependents.includes('src/main.js'));assert.ok(impact.testCandidates.some(f=>f.relative==='tests/value.test.mjs'));
});
test('test discovery distinguishes Node/Python test files and CI/configuration without execution',async t=>{
  const {write,ctx}=fixture(t);write('tests/demo.test.mjs','');write('ui/form.spec.ts','');write('test_math.py','');write('src/main.js','');write('pyproject.toml','[tool.pytest.ini_options]');write('.github/workflows/check.yml','name: Fixture');
  const result=await execute('test_discover',{},ctx);assert.equal(result.tests.length,3);assert.equal(result.pythonConfiguration.length,1);assert.equal(result.ciWorkflows.length,1);
});
test('check runner executes real tests and preserves failing stdout/exit status without hiding failures',async t=>{
  const {write,ctx}=fixture(t);write('package.json','{"type":"module","scripts":{"test":"node --test tests/*.test.mjs","deploy":"npm publish","check:bad":"npm publish"}}');
  write('tests/behavior.test.mjs',"import test from 'node:test'; import assert from 'node:assert/strict'; test('behavior',()=>assert.equal(1,2));");
  const failed=await execute('run_checks',{runner:'node_test'},ctx);assert.equal(failed.pass,false);assert.equal(failed.exitCode,1);assert.match(failed.stdout,/not ok/);assert.equal(failed.timedOut,false);
  write('tests/behavior.test.mjs',"import test from 'node:test'; import assert from 'node:assert/strict'; test('behavior',()=>assert.equal(2+2,4));");
  const passed=await execute('run_checks',{runner:'node_test'},ctx);assert.equal(passed.pass,true);assert.equal(passed.exitCode,0);assert.match(passed.stdout,/# pass 1/);
  await assert.rejects(execute('run_checks',{runner:'npm_script',script:'deploy'},ctx),/script families/);
  await assert.rejects(execute('run_checks',{runner:'npm_script',script:'check:bad'},ctx),/unsupported external operation/);
});
test('check policy exposes configured script body so shell approvals cannot be bypassed by the new name',t=>{
  const {write,ctx}=fixture(t);write('package.json',JSON.stringify({scripts:{'check:clean':'Remove-Item -LiteralPath fixture.tmp'}}));
  const policy=policyCommand('run_checks',{runner:'npm_script',script:'check:clean'},ctx);assert.match(policy,/npm run check:clean/);assert.match(policy,/Remove-Item/);
  assert.equal(policyCommand('project_map',{},ctx),null);
});
test('npm check policy and rejection include automatic pre/post lifecycle scripts',async t=>{
  const {write,ctx}=fixture(t);
  write('package.json',JSON.stringify({scripts:{test:'node --test',pretest:'Remove-Item -LiteralPath fixture.tmp',posttest:'node finish.mjs'}}));
  const policy=policyCommand('run_checks',{runner:'npm_script',script:'test'},ctx);
  assert.match(policy,/pretest: Remove-Item/);assert.match(policy,/test: node --test/);assert.match(policy,/posttest: node finish/);
  let executions=0;const guarded={...ctx,commandRunner:async()=>{executions++;return{exitCode:0,stdout:'',stderr:''};}};
  write('package.json',JSON.stringify({scripts:{test:'node --test',pretest:'git push origin main'}}));
  assert.match(policyCommand('run_checks',{runner:'npm_script',script:'test'},ctx),/pretest: git push/);
  await assert.rejects(execute('run_checks',{runner:'npm_script',script:'test'},guarded),/pretest lifecycle script.*unsupported external operation/);
  write('package.json',JSON.stringify({scripts:{test:'node --test',posttest:'npm publish'}}));
  assert.match(policyCommand('run_checks',{runner:'npm_script',script:'test'},ctx),/posttest: npm publish/);
  await assert.rejects(execute('run_checks',{runner:'npm_script',script:'test'},guarded),/posttest lifecycle script.*unsupported external operation/);
  assert.equal(executions,0);
});
test('npm check runner preserves normal safe pre/test/post lifecycle execution order',async t=>{
  const {root,write,ctx}=fixture(t);
  write('package.json',JSON.stringify({type:'module',scripts:{pretest:'node lifecycle.mjs pre',test:'node lifecycle.mjs test',posttest:'node lifecycle.mjs post'}}));
  write('lifecycle.mjs',"import fs from 'node:fs';fs.appendFileSync('lifecycle.txt',process.argv[2]+'\\n');");
  const result=await execute('run_checks',{runner:'npm_script',script:'test'},ctx);
  assert.equal(result.pass,true);assert.equal(result.exitCode,0);assert.equal(fs.readFileSync(path.join(root,'lifecycle.txt'),'utf8'),'pre\ntest\npost\n');
});
test('npm policy and lifecycle validation inspect raw bodies before secret display redaction',async t=>{
  const {write,ctx}=fixture(t);write('package.json',JSON.stringify({scripts:{test:'node --test',pretest:'SECRET="prefix-git push origin main"'}}));
  const displayed=await execute('project_map',{},ctx);assert.equal(displayed.package.scripts.pretest.includes('git push'),false);
  const policy=policyCommand('run_checks',{runner:'npm_script',script:'test'},ctx);assert.match(policy,/git push origin main/);
  let executions=0;await assert.rejects(execute('run_checks',{runner:'npm_script',script:'test'},{...ctx,commandRunner:async()=>{executions++;return{exitCode:0,stdout:'',stderr:''};}}),/pretest lifecycle script.*unsupported external operation/);
  assert.equal(executions,0);
});
test('security scan returns location/rule evidence without exposing matched secret values',async t=>{
  const {write,ctx}=fixture(t),secret='ghp_'+'A'.repeat(30);write('src/config.js',`const credential='${secret}';\nprocess.env.NODE_TLS_REJECT_UNAUTHORIZED='0';\neval(userInput);`);write('node_modules/ignored.js',`const key='${secret}';`);
  const result=await execute('security_scan',{},ctx);assert.ok(result.findings.some(f=>f.rule==='github-token'&&f.line===1));assert.ok(result.findings.some(f=>f.rule==='tls-verification-disabled'));assert.equal(result.filesScanned,1);assert.equal(JSON.stringify(result).includes(secret),false);assert.match(result.note,/not establish security/);
  write('.env','SERVICE_TOKEN=fixture-credential-value');
  const env=await execute('security_scan',{},ctx);assert.ok(env.findings.some(f=>f.rule==='environment-secret'));assert.equal(JSON.stringify(env).includes('fixture-credential-value'),false);
});
test('Git inspection preserves dirty work and sanitizes remote URL credentials',async t=>{
  const {root,write,ctx}=await repository(t);write('alpha.txt','changed\n');write('untracked with spaces.txt','retain');
  await git(root,'remote','add','private','https://fixture-user:private-password@example.invalid/repository.git');
  const before=await git(root,'status','--porcelain=v1','-z');const result=await execute('git_inspect',{},ctx);const after=await git(root,'status','--porcelain=v1','-z');
  assert.equal(before,after);assert.equal(result.branch,'main');assert.equal(result.dirty,true);assert.ok(result.changes.some(row=>row.path==='untracked with spaces.txt'));assert.equal(JSON.stringify(result).includes('private-password'),false);assert.equal(JSON.stringify(result).includes('fixture-user'),false);
});
test('structured Git diffs separate staged/working changes and report whitespace without index mutation',async t=>{
  const {root,write,ctx}=await repository(t);write('alpha.txt','staged\n');await git(root,'add','alpha.txt');write('alpha.txt','unstaged  \n');
  const before=await git(root,'status','--porcelain=v1','-z'),staged=await execute('git_diff',{staged:true},ctx),working=await execute('git_diff',{},ctx);
  assert.match(staged.patch,/\+staged/);assert.match(working.patch,/\+unstaged/);assert.equal(working.whitespace.pass,false);assert.equal(await git(root,'status','--porcelain=v1','-z'),before);
  await assert.rejects(execute('git_diff',{base:'--output=unsafe'},ctx),/Invalid ref/);
  const magic=await execute('git_diff',{paths:[':(glob)**/*.txt']},ctx);assert.deepEqual(magic.files,[]);assert.equal(magic.patch,'');
});
test('commit planning separates selected/unrelated changes and never stages or commits',async t=>{
  const {root,write,ctx}=await repository(t);write('alpha.txt','selected\n');write('unrelated.txt','other');await git(root,'add','unrelated.txt');
  const before=await git(root,'status','--porcelain=v1','-z'),head=(await git(root,'rev-parse','HEAD')).trim();
  const result=await execute('git_commit_plan',{paths:['alpha.txt']},ctx);assert.equal(result.performedChanges,false);assert.equal(result.selectedChanges[0].path,'alpha.txt');assert.ok(result.unrelatedChanges.some(row=>row.path==='unrelated.txt'));assert.ok(result.stagedChanges.some(row=>row.path==='unrelated.txt'));
  assert.equal(await git(root,'status','--porcelain=v1','-z'),before);assert.equal((await git(root,'rev-parse','HEAD')).trim(),head);
});
test('sync planning labels tracking counts and a live local-bare remote check without fetching',async t=>{
  const {root,write,ctx}=await repository(t),bare=path.join(root,'remote.git');await git(root,'clone','--bare','.',bare);await git(root,'remote','add','origin',bare);await git(root,'fetch','origin');await git(root,'branch','--set-upstream-to=origin/main','main');
  write('alpha.txt','next commit\n');await git(root,'add','alpha.txt');await git(root,'commit','-m','Outgoing fixture');
  const before=(await git(root,'rev-parse','refs/remotes/origin/main')).trim(),result=await execute('git_sync_plan',{checkRemote:true},ctx);
  assert.deepEqual(result.divergence,{ahead:1,behind:0,evidence:'local_tracking_ref'});assert.equal(result.liveRemote.verified,true);assert.equal(result.liveRemote.sha,before);assert.equal(result.performedChanges,false);assert.equal((await git(root,'rev-parse','refs/remotes/origin/main')).trim(),before);
});
test('sync planning reports unknown divergence when the tracking comparison fails',async t=>{
  const {root,ctx}=fixture(t);
  const commandRunner=async(executable,argv)=>{
    const op=argv.slice(argv.indexOf('-C')+2);
    if(op[0]==='rev-list')return{exitCode:128,stdout:'',stderr:'tracking object unavailable'};
    const stdout=op.includes('--show-toplevel')?root:op[0]==='symbolic-ref'?'main':op.includes('--symbolic-full-name')?'origin/main':'a'.repeat(40);
    return{exitCode:0,stdout:stdout+'\n',stderr:''};
  };
  const result=await execute('git_sync_plan',{remote:'origin',branch:'main'},{...ctx,commandRunner});
  assert.equal(result.divergence,null);assert.match(result.divergenceError,/tracking object unavailable/);assert.match(result.recommendation,/Could not establish/);assert.equal(result.recommendation.includes('No local tracking divergence'),false);
});
test('push preflight inspects the push destination instead of a different fetch URL and never pushes',async t=>{
  const {root,ctx}=await repository(t),fetchBare=path.join(root,'fetch.git'),pushBare=path.join(root,'push.git');
  await git(root,'clone','--bare','.',fetchBare);await git(root,'init','--bare',pushBare);await git(root,'remote','add','origin',fetchBare);await git(root,'remote','set-url','--push','origin',pushBare);
  const result=await execute('git_push_preflight',{remote:'origin',branch:'main'},ctx);assert.equal(result.remoteTip.verified,true);assert.equal(result.remoteTip.newBranch,true);assert.equal(result.remoteTip.sha,null);assert.equal(result.outgoingCount,1);assert.equal(result.fastForwardPossible,true);assert.equal(result.performedPush,false);assert.equal(result.protectionStatus,'not_checked');
  assert.equal((await git(root,'ls-remote','--heads',pushBare,'refs/heads/main')).trim(),'');
});
test('GitHub CLI adapters use explicit read-only argv, report setup dependencies and bound failed logs',async t=>{
  const {ctx}=fixture(t),commands=[];
  const commandRunner=async(executable,argv)=>{commands.push({executable,argv});return{exitCode:0,stdout:argv.includes('--log-failed')?'X'.repeat(2500):JSON.stringify(argv[0]==='pr'?{number:7,headRefOid:'fixture-sha'}:{databaseId:19,headSha:'fixture-sha',jobs:[]}),stderr:''};};
  const pr=await execute('github_pr_inspect',{repository:'fixture/project',number:7},{...ctx,commandRunner});assert.equal(pr.available,true);assert.equal(pr.record.headRefOid,'fixture-sha');assert.equal(pr.mode,'read_only');
  const run=await execute('github_actions_inspect',{repository:'fixture/project',runId:19,failedLogs:true,maxLogCharacters:1000},{...ctx,commandRunner});assert.equal(run.failedLogs.output.length,1000);assert.equal(run.failedLogs.truncated,true);assert.ok(commands.every(c=>c.executable==='gh'&&c.argv[1]==='view'));
  const missing=await execute('github_pr_inspect',{repository:'fixture/project',number:7},{...ctx,commandRunner:async()=>({exitCode:null,stdout:'',stderr:'',error:'gh not installed'})});assert.equal(missing.available,false);assert.match(missing.dependency,/authenticated/);
  await assert.rejects(execute('github_pr_inspect',{repository:'fixture/project --all',number:7},{...ctx,commandRunner}),/owner\/name/);
});
