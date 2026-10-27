import test from 'node:test';
import assert from 'node:assert/strict';
import {SIDEBAR_GROUPS,normalizeSidebarLayout,sidebarGroupAncestors,moveSidebarGroup,normalizeSidebarOrder,moveSidebarKeys} from '../public/sidebar-layout.js';

test('default sidebar layout includes every fixed display group exactly once',()=>{
  const layout=normalizeSidebarLayout(null);assert.equal(layout.version,1);assert.deepEqual(layout.groups,SIDEBAR_GROUPS.map(({id})=>({id,parent:null})));
  assert.deepEqual(normalizeSidebarLayout({version:1,groups:[]}),layout);
});
test('nesting a group carries its existing subgroup tree and keeps sibling order',()=>{
  const original=normalizeSidebarLayout(null),before=structuredClone(original);
  let layout=moveSidebarGroup(original,{id:'github',parent:'engineering'});
  layout=moveSidebarGroup(layout,{id:'quality',parent:'github'});
  layout=moveSidebarGroup(layout,{id:'engineering',parent:'research'});
  assert.deepEqual(sidebarGroupAncestors(layout,'quality'),['github','engineering','research']);
  assert.deepEqual(layout.groups.filter(group=>group.parent===null).map(group=>group.id),['research','operations','','rooms']);
  assert.deepEqual(original,before);
});
test('Other agents can be a real parent and is distinct from the top level',()=>{
  const layout=moveSidebarGroup(null,{id:'engineering',parent:''});
  assert.deepEqual(sidebarGroupAncestors(layout,'engineering'),['']);
  const out=moveSidebarGroup(layout,{id:'engineering',parent:null,before:'research'});
  assert.equal(out.groups.find(group=>group.id==='engineering').parent,null);
});
test('group reorder and unnest change only the requested position and preserve descendants',()=>{
  let layout=moveSidebarGroup(null,{id:'github',parent:'engineering'});
  layout=moveSidebarGroup(layout,{id:'quality',parent:'github'});
  layout=moveSidebarGroup(layout,{id:'github',parent:null,before:'engineering'});
  assert.equal(layout.groups[0].id,'github');assert.equal(layout.groups[1].id,'quality');assert.equal(layout.groups[2].id,'engineering');
  assert.deepEqual(sidebarGroupAncestors(layout,'quality'),['github']);
});
test('self nesting and indirect cycles fail without modifying the original layout',()=>{
  const layout=moveSidebarGroup(null,{id:'github',parent:'engineering'}),before=structuredClone(layout);
  assert.throws(()=>moveSidebarGroup(layout,{id:'engineering',parent:'github'}),/descendants/);
  assert.throws(()=>moveSidebarGroup(layout,{id:'github',parent:'github'}),/descendants/);
  assert.throws(()=>normalizeSidebarLayout({version:1,groups:[{id:'engineering',parent:'github'},{id:'github',parent:'engineering'}]}),/ancestors/);
  assert.deepEqual(layout,before);
});
test('unknown groups, malformed parents, duplicates and wrong-parent anchors are rejected',()=>{
  for(const value of [{version:2,groups:[]},{version:1,groups:[{id:'unknown',parent:null}]},{version:1,groups:[{id:'quality'}]},{version:1,groups:[{id:'quality',parent:0}]},{version:1,groups:[{id:'quality',parent:null},{id:'quality',parent:null}]}])assert.throws(()=>normalizeSidebarLayout(value));
  const layout=moveSidebarGroup(null,{id:'github',parent:'engineering'});
  assert.throws(()=>moveSidebarGroup(layout,{id:'quality',parent:null,before:'github'}),/another group/);
  assert.throws(()=>moveSidebarGroup(layout,{id:'quality',parent:'orchestrator'}),/known/);
});
test('moving a visible agent branch preserves every unrelated and hidden sidebar entry',()=>{
  const order=['bot:1','bot:2','bot:3','room:7','bot:8','bot:9'],before=[...order];
  assert.deepEqual(moveSidebarKeys(order,['bot:2','bot:3'],'bot:9'),['bot:1','room:7','bot:8','bot:2','bot:3','bot:9']);
  assert.deepEqual(order,before);assert.deepEqual(moveSidebarKeys(order,['bot:2'],null),['bot:1','bot:3','room:7','bot:8','bot:9','bot:2']);
  assert.throws(()=>moveSidebarKeys(order,['bot:2'],'bot:2'),/insertion/);
});
test('sidebar order sanitizing bounds persistence without admitting group or prototype keys',()=>{
  assert.deepEqual(normalizeSidebarOrder(['bot:1','room:3','bot:1','bot:0','group:engineering','__proto__',{},null]),['bot:1','room:3']);
  assert.equal(normalizeSidebarOrder(Array.from({length:600},(_,index)=>'bot:'+(index+1))).length,500);
});
