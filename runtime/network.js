const localAddresses=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
export const loopback=req=>localAddresses.has(req.socket.remoteAddress);
export const forwarded=req=>['x-forwarded-for','forwarded','cf-connecting-ip','cf-ray','x-forwarded-host','x-forwarded-proto'].some(h=>Boolean(req.headers[h]));
export const directLocal=req=>loopback(req)&&!forwarded(req);
export function secureRequest(req){return Boolean(req.socket.encrypted)||(loopback(req)&&String(req.headers['x-forwarded-proto']).split(',')[0].trim()==='https');}
export function requestIp(req){return loopback(req)?String(req.headers['cf-connecting-ip']||req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',')[0].trim():req.socket.remoteAddress;}
export function sameOriginRequest(req){
  const origin=req.headers.origin;if(!origin)return true;
  try{return new URL(origin).origin===new URL((secureRequest(req)?'https://':'http://')+req.headers.host).origin;}catch{return false;}
}
