import fs from 'node:fs';
import { config } from '../runtime/config.js';
import { cloudStatus } from '../runtime/codex.js';
import { localCatalog } from '../runtime/local.js';
import { resources } from '../runtime/resources.js';
import { chromium } from 'playwright';
const c=config();
const [cloud,local,hardware]=await Promise.all([cloudStatus({fresh:true}),localCatalog(c),resources({fresh:true})]);
const result={platform:process.platform,node:process.versions.node,
  cloud:{authenticated:cloud.subscription,plan:cloud.plan,models:cloud.models?.map(m=>m.id),error:cloud.error},
  local:{configured:c.local.enabled,catalogue:local,credentialFileConfigured:!!c.local.tokenDpapiFile,credentialFileExists:c.local.tokenDpapiFile?fs.existsSync(c.local.tokenDpapiFile):null},
  browser:{installed:fs.existsSync(chromium.executablePath()),executable:chromium.executablePath()},hardware,
  lumosIntegration:'disconnected',hypervisorRequired:false};
console.log(JSON.stringify(result,null,2));
if(!result.browser.installed||(!cloud.subscription&&!local.ok))process.exitCode=1;
