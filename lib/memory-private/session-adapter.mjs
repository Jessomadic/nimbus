export function createSessionAdapter({sessions,ownerId,scopes,secureRequest,sameOriginRequest}){
 if(!ownerId||!Array.isArray(scopes))throw Error('INVALID_CONFIGURATION');
 const live=new WeakMap();
 function valid(req){
  if(!secureRequest(req)||!sameOriginRequest(req))return false;
  const token=(req.headers.cookie||'').match(/(?:^|;\s*)__Host-nimbus_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  const row=token&&sessions.authenticate(token);
  return !!row&&row.email==='';
 }
 return {authenticate(req){if(!valid(req))return null;const p={ownerId};live.set(p,req);return p;},
 authorize(p,s){return !!live.get(p)&&valid(live.get(p))&&scopes.includes(s);}};
}
