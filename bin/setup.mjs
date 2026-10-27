import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ROOT, CONFIG_FILE, defaults } from '../runtime/config.js';
import { protect } from '../runtime/credentials.js';
const data=path.join(ROOT,'data');fs.mkdirSync(data,{recursive:true});
if(!fs.existsSync(CONFIG_FILE))fs.writeFileSync(CONFIG_FILE,JSON.stringify(defaults,null,2)+'\n');
const envFile=path.join(ROOT,'.env');
if(!fs.existsSync(envFile)){
  const password=randomBytes(24).toString('base64url');
  fs.writeFileSync(path.join(data,'ui-password.dpapi'),await protect(password),{mode:0o600});
  fs.writeFileSync(envFile,'HOST=127.0.0.1\nPORT=8787\nTZ=America/New_York\nNIMBUS_PASSWORD_DPAPI=data/ui-password.dpapi\nNIMBUS_HTTPS_PORT=0\n',{mode:0o600});
}
console.log('Nimbus configuration is ready. Use node bin/ui-password.mjs to display the local dashboard password, or node bin/nimbus.mjs OPEN to get a one-time local sign-in link.');
