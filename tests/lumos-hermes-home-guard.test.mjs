import test from 'node:test';
import assert from 'node:assert/strict';
import {lumosHermesHomeError} from '../runtime/tools.js';

const home='F:\\Nimbus\\data\\lumos\\home\\gen-x';

test('Lumos tool calls naming the retired Hermes home are refused with the Nimbus path (live 2026-11-25 edits)',()=>{
  // Exact shapes from the live runs: shell commands and apply_patch paths.
  for(const args of [
    {command:'$p="F:\\Projects\\Lumos\\HermesPilot\\home\\data\\tracker_outcomes.sqlite3"; python q.py $p'},
    {edits:[{operation:'update',path:'F:\\Projects\\Lumos\\HermesPilot\\home\\scripts\\weather_check.py'}]},
    {path:'F:/Projects/Lumos/HermesPilot/home/memories/MEMORY.md'},
    {command:'cd f:\\projects\\lumos\\hermespilot\\home\\scripts'},
    {path:'C:\\Users\\Example User\\Documents\\HermesPilot\\home\\data\\x.sqlite3'},
  ]){
    const e=lumosHermesHomeError(args,home);
    assert.ok(e,JSON.stringify(args));
    assert.equal(e.code,'hermes_home_retired');
    assert.ok(e.error.includes(home));
  }
});

test('the guard leaves the Nimbus home, the shared integrations runtime and look-alike names alone',()=>{
  for(const args of [
    {path:home+'\\data\\tracker_outcomes.sqlite3'},
    {command:'python F:\\Projects\\Lumos\\HermesPilot\\integrations\\knowledge_tools\\run.py'},
    {path:'F:\\Projects\\Lumos\\HermesPilot\\home-notes.txt'},
    {path:'F:\\Projects\\Lumos\\HermesPilot\\homework'},
    {text:'hello'},undefined,
  ])assert.equal(lumosHermesHomeError(args,home),null,JSON.stringify(args));
});
