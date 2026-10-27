#!/usr/bin/env node
// Recovery stays on the trusted Nimbus Windows account. The one-time HTTPS
// link also requires the configured username/password and physical passkey UV.
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from '../runtime/config.js';
const [action='enroll']=process.argv.slice(2);
if(action!=='enroll')throw new Error('Usage: node --env-file-if-exists=.env bin/passkeys.mjs enroll');
const data=path.resolve(process.env.NIMBUS_DATA||path.join(ROOT,'data'));
const token=fs.readFileSync(path.join(data,'admin.token'),'utf8').trim();
const response=await fetch(`http://127.0.0.1:${process.env.PORT||8787}/api/admin/passkeys/enrollment-ticket`,{method:'POST',headers:{'x-nimbus-admin':token,'content-type':'application/json'},body:'{}'});
const result=await response.json();
if(!response.ok)throw new Error(result.error||'Passkey enrollment link unavailable');
console.log('Owner recovery link: open it on the replacement device within 15 minutes. Sign in with your username and existing password, then approve passkey creation. First-time setup uses the normal sign-in page and does not need this link.');
console.log(result.url);
