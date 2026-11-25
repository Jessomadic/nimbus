import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMcpScopes,permits,effectTransportHash,reviewedReadOnly} from '../runtime/mcp-scope.js';
const make=()=>({url:'https://fixture.invalid/mcp',credentialBinding:{sourceId:'fixture',destination:'http-bearer'},scope:{allow:{workerIds:[2]}},reviewedTools:['echo']});
test('protected policies fail closed when missing or malformed; exact worker and raw tool only',()=>{
 const valid=make();
 validateMcpScopes({mcpServers:{fixture:valid}},{credentialResolver:true});
 assert.equal(permits(valid,{id:2},{},'echo'),true);
 assert.equal(permits(valid,{id:3},{},'echo'),false);
 assert.equal(permits(valid,{id:2},{},'guessed'),false);
 for(const key of ['scope','reviewedTools']){
  const def=make();delete def[key];
  assert.throws(()=>validateMcpScopes({mcpServers:{fixture:def}},{credentialResolver:true}));
  assert.equal(permits(def,{id:2},{},'echo'),false);
 }
 for(const change of [{scope:null},{scope:{allow:{workerIds:[0]}}},{reviewedTools:'echo'},{reviewedTools:['echo','echo']},{reviewedEffects:{echo:{effect:'read',transportHash:'bad'}}}]){
  const def={...make(),...change};
  assert.throws(()=>validateMcpScopes({mcpServers:{fixture:def}},{credentialResolver:true}));
  assert.equal(permits(def,{id:2},{},'echo'),false);
 }
});
test('host effects require exact server transport and raw tool; missing/write/unknown remain uncertain',()=>{
 const def=make();
 assert.equal(reviewedReadOnly('fixture',def,'echo'),false);
 for(const effect of ['read','write','unknown']){
  def.reviewedEffects={echo:{effect,transportHash:effectTransportHash('fixture',def)}};
  validateMcpScopes({mcpServers:{fixture:def}},{credentialResolver:true});
  assert.equal(reviewedReadOnly('fixture',def,'echo'),effect==='read');
 }
 def.reviewedEffects.echo.effect='read';
 assert.equal(reviewedReadOnly('other',def,'echo'),false);
 assert.equal(reviewedReadOnly('fixture',def,'other'),false);
 def.url='https://fixture.invalid/changed';
 assert.equal(reviewedReadOnly('fixture',def,'echo'),false);
});
