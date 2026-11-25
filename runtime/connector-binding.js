// Trusted host schema; no approval authority is inferred from broker output.
const fail=()=>{throw new Error('Protected connector credential unavailable');};
const id=/^[a-f0-9]{16}:[a-f0-9]{32}$/;
// JSON cannot preserve holes, inherited elements, accessors or extra own properties.
function ownData(o,keys){
 const actual=Reflect.ownKeys(o);
 if(actual.length!==keys.length||actual.some(k=>!keys.includes(k)))fail();
 for(const k of keys){
  const d=Object.getOwnPropertyDescriptor(o,k);
  if(!d||!Object.hasOwn(d,'value')||(k!=='length'&&!d.enumerable))fail();
 }
}
function denseChain(chain){
 if(!Array.isArray(chain)||Object.getPrototypeOf(chain)!==Array.prototype||chain.length<4||chain.length>64)fail();
 ownData(chain,['length',...Array.from({length:chain.length},(_,i)=>String(i))]);
 for(let i=0;i<chain.length;i++)if(typeof chain[i]!=='string'||!id.test(chain[i]))fail();
}
export function bindingV1(b,r,a){
 const keys=['version','ownerSid','profileId','storeId','runtimeId','sourceId','revision','approvalRevision','chain','sha256'];
 if(!b||Object.getPrototypeOf(b)!==Object.prototype)fail();
 ownData(b,keys);denseChain(b.chain);
 if(b.version!==1||b.ownerSid!==r.ownerSid||b.sourceId!==r.sourceId||b.revision!==r.revision||
 b.approvalRevision!==a.revision||r.approvalRevision!==a.revision||b.sha256!==r.sha256||
 b.runtimeId!==a.sha256||!id.test(b.profileId)||!id.test(b.storeId)||
 b.chain.at(-2)!==b.storeId||!b.chain.includes(b.profileId)||
 r.binding!==[b.ownerSid,...b.chain,b.sha256].join('|'))fail();
 return Object.freeze({...b,chain:Object.freeze([...b.chain])});
}
