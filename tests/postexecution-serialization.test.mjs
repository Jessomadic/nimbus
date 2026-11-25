import test from 'node:test';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {register} from 'node:module';
process.env.SERIALIZATION_FIXTURE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'serialization-owned-'));
register('./postexecution-loader.mjs',import.meta.url);
const {exercise,runner,db}=await import('./postexecution-fixture.mjs');
for(const route of ['silence','limit','interrupted']){
 for(const kind of ['cycle','bigint','getter','event-getter','cycle-refusal','cycle-stop','cycle-denial','error-cycle','error-bigint','error-getter','throw-null'])
 test(route+'/'+kind,()=>exercise(route,'broken-'+kind));
 for(const guard of ['safeJournal','denial'])test(route+'/control-'+guard,()=>exercise(route,guard));
}
test.after(async()=>{await runner.drainRuntime();db.close();});