// Lumos (iMessage) connection settings. The `lumos` block lives only in
// nimbus.config.json; it is not editable through the runtime config API.
import fs from 'node:fs';

export {LUMOS_DEFAULTS,validateLumosConfig} from './config.js';
// The same one-chat allowlist the relay enforces (relay.py load_route). The
// owner number is read from route.json rather than hard-coded here.
export function loadLumosRoute(l,{read=file=>fs.readFileSync(file,'utf8')}={}){
  const bridge=JSON.parse(read(l.bridgeConfigPath)),owner=JSON.parse(read(l.ownerConfigPath).replace(/^\uFEFF/,''));
  const chat=owner.chat_guid,allowed=bridge.allowed_chats?.[chat];
  const address=String(owner.owner_handle||'').replace(/^tel:/,'');
  if(bridge.bind_host!=='127.0.0.1'||bridge.bind_port!==12345||!/^tel:\+\d{8,15}$/.test(owner.owner_handle||'')
    ||owner.bot_handle!==bridge.sender_handle||!allowed||typeof allowed!=='object'||allowed.address!==address
    ||Object.keys(bridge.allowed_chats||{}).length!==1)throw new Error('OpenBubbles allowlist no longer matches the approved chat');
  if(typeof bridge.api_token!=='string'||bridge.api_token.length<24)throw new Error('OpenBubbles token is missing or unexpectedly short');
  return Object.freeze({chat,owner:owner.owner_handle,bot:owner.bot_handle,token:bridge.api_token});
}
