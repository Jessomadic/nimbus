import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../runtime/config.js';
import { unprotect } from '../runtime/credentials.js';
console.log(await unprotect(fs.readFileSync(path.join(ROOT,'data','ui-password.dpapi'),'utf8')));
