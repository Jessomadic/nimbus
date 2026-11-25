import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMcpScopes} from '../runtime/mcp-scope.js';
test('policy selectors reject glob syntax instead of misleading wildcard grants',()=>{for(const template of ['*','builder?'])assert.throws(()=>validateMcpScopes({mcpServers:{s:{scope:{allow:{templates:[template]}}}}}),/selector/);});
