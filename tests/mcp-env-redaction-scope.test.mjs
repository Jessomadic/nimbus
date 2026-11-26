import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
process.env.NIMBUS_DATA=fs.mkdtempSync(path.join(os.tmpdir(),'env-redaction-'));
const {sanitizeConfiguredValue,cleanConnectorError}=await import('../runtime/mcp.js');

// Live 2026-11-25: every connector sets PYTHONDONTWRITEBYTECODE="1", so every "1" in
// connector results became [REDACTED] (a transcript's "412" reached Lumos as "4[REDACTED]2").
const definition={command:'fixture',env:{PYTHONDONTWRITEBYTECODE:'1',CUA_DRIVER_RS_TELEMETRY_ENABLED:'0',
  HOME:'F:/Nimbus/data/bots/7/private/home',TEMP:'F:/Nimbus/data/bots/7/private/tmp',FIXTURE_TOKEN:'synthetic-secret-9137'},
  headers:{Authorization:'Bearer synthetic-header-4410'}};

test('short and standard non-secret env values do not corrupt connector results',()=>{
  const text='The magic number is 412 on 2026-11-26 at 10:01; files in F:/Nimbus/data/bots/7/private/home';
  const out=sanitizeConfiguredValue({content:[{type:'text',text}]},definition);
  assert.equal(out.content[0].text,text);
});

test('real configured secrets are still redacted in results and errors',()=>{
  const out=sanitizeConfiguredValue({content:[{type:'text',text:'token synthetic-secret-9137 header synthetic-header-4410 n=1'}]},definition);
  assert.equal(out.content[0].text,'token [REDACTED] header [REDACTED] n=1');
  assert.equal(cleanConnectorError('MCP error -32001: synthetic-secret-9137',definition),'MCP error -32001: [REDACTED]');
});
