import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest();
const base64url=value=>Buffer.from(value).toString('base64url');

// This fixture needs only integer/string/byte-string/map CBOR values. Keeping
// the encoder here lets the synthetic authenticator remain independent of the
// WebAuthn verifier and of production database/configuration modules.
function head(major,length){
  if(!Number.isSafeInteger(length)||length<0||length>0xffffffff)throw new Error('Unsupported fixture CBOR length');
  if(length<24)return Buffer.from([(major<<5)|length]);
  if(length<=0xff)return Buffer.from([(major<<5)|24,length]);
  if(length<=0xffff){const out=Buffer.alloc(3);out[0]=(major<<5)|25;out.writeUInt16BE(length,1);return out;}
  const out=Buffer.alloc(5);out[0]=(major<<5)|26;out.writeUInt32BE(length,1);return out;
}

function cbor(value){
  if(typeof value==='number')return value>=0?head(0,value):head(1,-1-value);
  if(typeof value==='string'){const bytes=Buffer.from(value,'utf8');return Buffer.concat([head(3,bytes.length),bytes]);}
  if(value instanceof Uint8Array){const bytes=Buffer.from(value);return Buffer.concat([head(2,bytes.length),bytes]);}
  if(value instanceof Map){return Buffer.concat([head(5,value.size),...Array.from(value,([key,item])=>Buffer.concat([cbor(key),cbor(item)]))]);}
  throw new Error('Unsupported fixture CBOR value');
}

function authenticatorData(rpID,flags,counter,tail=Buffer.alloc(0)){
  if(typeof rpID!=='string'||!rpID)throw new Error('The fixture requires an RP ID');
  const value=Buffer.alloc(37);hash(rpID).copy(value,0);value.writeUInt8(flags,32);value.writeUInt32BE(counter,33);
  return Buffer.concat([value,tail]);
}

function clientData(type,{origin,challenge,clientDataOverrides}){
  if(typeof origin!=='string'||!origin)throw new Error('The fixture requires an explicit origin');
  return Buffer.from(JSON.stringify({type,challenge,origin,crossOrigin:false,...clientDataOverrides}));
}

function credentialID(id){return id instanceof Uint8Array?base64url(id):id;}

export class PasskeyAuthenticator{
  #privateKey;
  #rawId;

  constructor(options={}){
    const {id=randomBytes(32)}=options instanceof Uint8Array?{id:options}:options;
    if(!(id instanceof Uint8Array)||id.length===0||id.length>0xffff)throw new Error('Fixture credential ID must be 1–65535 bytes');
    this.#rawId=Buffer.from(id);this.id=base64url(this.#rawId);
    const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    this.#privateKey=privateKey;
    const jwk=publicKey.export({format:'jwk'});
    this.publicKey=cbor(new Map([
      [1,2], [3,-7], [-1,1],
      [-2,Buffer.from(jwk.x,'base64url')],[-3,Buffer.from(jwk.y,'base64url')],
    ]));
    this.userHandle=undefined;
  }

  register(options,{
    origin,rpID=options.rp.id,challenge=options.challenge,flags=0x45,counter=0,
    clientDataOverrides={},idOverride,
  }={}){
    this.userHandle=options.user.id;
    const credentialLength=Buffer.alloc(2);credentialLength.writeUInt16BE(this.#rawId.length);
    const attestedCredentialData=Buffer.concat([Buffer.alloc(16),credentialLength,this.#rawId,this.publicKey]);
    const authData=authenticatorData(rpID,flags,counter,attestedCredentialData);
    const client=clientData('webauthn.create',{origin,challenge,clientDataOverrides});
    const outerId=credentialID(idOverride??this.id);
    return{
      id:outerId,rawId:outerId,type:'public-key',authenticatorAttachment:'platform',
      clientExtensionResults:{credProps:{rk:true}},
      response:{
        clientDataJSON:base64url(client),
        attestationObject:base64url(cbor(new Map([['fmt','none'],['attStmt',new Map()],['authData',authData]]))),
        transports:['internal'],
      },
    };
  }

  authenticate(options,{
    origin,rpID=options.rpId,challenge=options.challenge,flags=0x05,counter=1,
    userHandle=this.userHandle,clientDataOverrides={},badSignature=false,idOverride,
  }={}){
    const authData=authenticatorData(rpID,flags,counter);
    const client=clientData('webauthn.get',{origin,challenge,clientDataOverrides});
    const signature=sign('sha256',Buffer.concat([authData,hash(client)]),this.#privateKey);
    if(badSignature)signature[signature.length-1]^=1;
    const outerId=credentialID(idOverride??this.id);
    return{
      id:outerId,rawId:outerId,type:'public-key',authenticatorAttachment:'platform',clientExtensionResults:{},
      response:{
        clientDataJSON:base64url(client),authenticatorData:base64url(authData),signature:base64url(signature),
        ...(userHandle===undefined?{}:{userHandle:userHandle instanceof Uint8Array?base64url(userHandle):userHandle}),
      },
    };
  }
}
