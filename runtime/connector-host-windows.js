// Explicit trusted-host composition only. Not selected by tools.js or config.
// Logical enrollment profileId remains distinct from native FileIdInfo profileId.
import {createConnectorHost} from './connector-host.js';
import {readApprovalMapping,createPersistedWindowsConnectorStore} from './connector-approval-registry.js';
const fail=()=>new Error('Protected connector credential unavailable');
export async function createPersistedWindowsConnectorHost({directory,enrollment,identity,authorize,diagnostics}={}) {
  if(enrollment===undefined)return createConnectorHost();
  let backend;
  try {
    if(!Array.isArray(enrollment)||!enrollment.length||typeof identity!=='function'||typeof authorize!=='function')throw fail();
    const entries=structuredClone(enrollment);
    const mapping=readApprovalMapping(directory);
    for(const e of entries){
      const r=mapping.records.find(r=>r.sourceId===e.sourceId);
      if(!r||r.ownerSid!==e.ownerSid||r.revision!==e.revision)throw fail();
    }
    backend=createPersistedWindowsConnectorStore({directory,diagnostics});
    return createConnectorHost({enrollment:entries,backend,identity,authorize});
  } catch {
    if(backend)await backend.close();
    throw fail();
  }
}
