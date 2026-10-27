import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {
  generateAuthenticationOptions,generateRegistrationOptions,
  verifyAuthenticationResponse,verifyRegistrationResponse,
} from '@simplewebauthn/server';

const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(first,second)=>typeof first==='string'&&typeof second==='string'&&first.length===second.length&&timingSafeEqual(Buffer.from(first),Buffer.from(second));
const failure=(statusCode=401)=>Object.assign(new Error(statusCode===409?'Passkey operation conflicts with current state':statusCode===400?'Invalid passkey response':'Passkey verification expired or was rejected'),{statusCode});
const token=()=>randomBytes(32).toString('hex');
const tokenKey=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?hash(value):null;
const canonicalID=value=>typeof value==='string'&&value.length>0&&value.length<=1364&&/^[A-Za-z0-9_-]+$/.test(value)&&Buffer.from(value,'base64url').toString('base64url')===value&&Buffer.from(value,'base64url').length<=1023;
const transportList=value=>Array.isArray(value)?[...new Set(value.filter(item=>typeof item==='string'&&['ble','cable','hybrid','internal','nfc','smart-card','usb'].includes(item)))]:[];

/** One configured owner. The HTTP layer authorizes password and enrollment access. */
export class PasskeyStore{
  #pending=new Map();
  #bootstrap=new Map();
  constructor({db,rpOrigin,username,binding,now=Date.now,webAuthn={}}){
    let origin;
    try{origin=new URL(rpOrigin);}catch{throw new Error('A fixed HTTPS passkey origin is required');}
    if(typeof rpOrigin!=='string'||origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||origin.origin!==rpOrigin||!origin.hostname){throw new Error('A fixed HTTPS passkey origin without a path or credentials is required');}
    if(typeof username!=='string'||!username.trim()||username!==username.trim()||username.length>64||/[\x00-\x1f\x7f]/.test(username)||typeof binding!=='function'||typeof now!=='function')throw new Error('A configured passkey owner and credential binding are required');
    this.db=db;this.rpOrigin=origin.origin;this.rpID=origin.hostname;this.username=username;this.binding=binding;this.now=now;
    this.webAuthn={generateAuthenticationOptions,generateRegistrationOptions,verifyAuthenticationResponse,verifyRegistrationResponse,...webAuthn};
    db.exec(`CREATE TABLE IF NOT EXISTS passkey_owner(id INTEGER PRIMARY KEY CHECK(id=1),user_handle BLOB NOT NULL CHECK(length(user_handle)=32),version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS passkey_credentials(id TEXT PRIMARY KEY,public_key BLOB NOT NULL,counter INTEGER NOT NULL,transports TEXT NOT NULL DEFAULT '[]',label TEXT NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER,device_type TEXT NOT NULL,backed_up INTEGER NOT NULL);`);
    db.prepare('INSERT OR IGNORE INTO passkey_owner(id,user_handle,version) VALUES(1,?,0)').run(randomBytes(32));
  }
  version(){return this.db.prepare('SELECT version FROM passkey_owner WHERE id=1').get().version;}
  count(){return this.db.prepare('SELECT count(*) AS n FROM passkey_credentials').get().n;}
  list(){return this.db.prepare('SELECT id,label,created_at AS createdAt,last_used_at AS lastUsedAt FROM passkey_credentials ORDER BY created_at,id').all().map(row=>({...row}));}
  #owner(){return this.db.prepare('SELECT * FROM passkey_owner WHERE id=1').get();}
  #binding(){const current=this.binding();return typeof current==='string'&&current?hash(current):null;}
  #prune(){const now=this.now();for(const [id,item] of this.#pending)if(item.until<=now)this.#pending.delete(id);for(const [id,item] of this.#bootstrap)if(item.until<=now)this.#bootstrap.delete(id);}
  #snapshot(item){
    let authorized=false;try{authorized=item.authorized?Boolean(item.authorized()):true;}catch{}
    if(item.until<=this.now()||!authorized||item.version!==this.version()||!same(item.binding,this.#binding()))throw failure();
  }
  createBootstrap(){
    this.#prune();const binding=this.#binding();if(!binding)throw failure();
    const value=token();this.#bootstrap.set(hash(value),{binding,version:this.version(),until:this.now()+15*60_000});return value;
  }
  consumeBootstrap(value){
    const key=tokenKey(value),item=key&&this.#bootstrap.get(key);if(key)this.#bootstrap.delete(key);
    if(!item)return false;try{this.#snapshot(item);return true;}catch{return false;}
  }
  begin({kind,browserToken,label='',authorized=()=>true}){
    this.#prune();
    if(!['authenticate','register'].includes(kind)||typeof browserToken!=='string'||!browserToken||browserToken.length>1024||typeof label!=='string'||label.length>80||/[\x00-\x1f\x7f]/.test(label)||typeof authorized!=='function')throw failure(400);
    const binding=this.#binding();if(!binding)throw failure();
    if(kind==='authenticate'&&!this.count())throw failure();
    const value=token(),item={kind,browser:hash(browserToken),binding,version:this.version(),label:label.trim()||'Passkey',until:this.now()+5*60_000,challenge:null,options:null,generating:null,authorized};
    this.#snapshot(item);this.#pending.set(hash(value),item);return value;
  }
  #ticket(value,browserToken,kind,{consume=false}={}){
    const key=tokenKey(value),item=key&&this.#pending.get(key);
    // A verification request gets one attempt, including malformed or wrong-browser requests.
    if(consume&&key)this.#pending.delete(key);
    if(!item||item.kind!==kind||typeof browserToken!=='string'||!same(item.browser,hash(browserToken)))throw failure();
    this.#snapshot(item);if(consume&&!item.challenge)throw failure();return item;
  }
  async #options(value,browserToken,kind){
    const item=this.#ticket(value,browserToken,kind);
    if(item.options)return structuredClone(item.options);
    if(item.generating)return structuredClone(await item.generating);
    item.generating=(async()=>{
      const credentials=this.db.prepare('SELECT id,transports FROM passkey_credentials').all().map(row=>({id:row.id,transports:transportList(JSON.parse(row.transports))}));
      const options=kind==='authenticate'
        ?await this.webAuthn.generateAuthenticationOptions({rpID:this.rpID,allowCredentials:credentials,userVerification:'required',challenge:randomBytes(32),timeout:5*60_000})
        :await this.webAuthn.generateRegistrationOptions({rpName:'Nimbus',rpID:this.rpID,userName:this.username,userDisplayName:this.username,userID:new Uint8Array(this.#owner().user_handle),attestationType:'none',excludeCredentials:credentials,authenticatorSelection:{residentKey:'required',userVerification:'required'},supportedAlgorithmIDs:[-7,-257],challenge:randomBytes(32),timeout:5*60_000});
      this.#snapshot(item);
      if(this.#pending.get(tokenKey(value))!==item||typeof options.challenge!=='string'||!options.challenge)throw failure();
      item.challenge=options.challenge;item.options=structuredClone(options);return item.options;
    })();
    try{return structuredClone(await item.generating);}catch(error){this.#pending.delete(tokenKey(value));throw error.statusCode?error:failure(400);}
  }
  authenticationOptions(ticket,browserToken){return this.#options(ticket,browserToken,'authenticate');}
  registrationOptions(ticket,browserToken){return this.#options(ticket,browserToken,'register');}
  #response(response){
    if(!response||response.type!=='public-key'||!canonicalID(response.id)||response.rawId!==response.id||!response.response||typeof response.response!=='object')throw failure(400);
  }
  #transaction(action){
    this.db.exec('SAVEPOINT nimbus_passkey_write');
    try{const result=action();this.db.exec('RELEASE nimbus_passkey_write');return result;}catch(error){this.db.exec('ROLLBACK TO nimbus_passkey_write; RELEASE nimbus_passkey_write');throw error;}
  }
  async verifyAuthentication(ticket,browserToken,response){
    const item=this.#ticket(ticket,browserToken,'authenticate',{consume:true});this.#response(response);
    const stored=this.db.prepare('SELECT * FROM passkey_credentials WHERE id=?').get(response.id);if(!stored)throw failure();
    const handle=response.response.userHandle;
    if(handle!=null&&(!canonicalID(handle)||!same(handle,Buffer.from(this.#owner().user_handle).toString('base64url'))))throw failure();
    const publicKey=Buffer.from(stored.public_key),counter=stored.counter;
    let result;
    try{result=await this.webAuthn.verifyAuthenticationResponse({response,expectedChallenge:item.challenge,expectedOrigin:this.rpOrigin,expectedRPID:this.rpID,requireUserVerification:true,credential:{id:stored.id,publicKey:new Uint8Array(publicKey),counter,transports:transportList(JSON.parse(stored.transports))}});}catch{throw failure(400);}
    this.#snapshot(item);
    const info=result?.authenticationInfo;
    if(!result?.verified||!info?.userVerified||info.credentialID!==stored.id||info.origin!==this.rpOrigin||info.rpID!==this.rpID||!Number.isSafeInteger(info.newCounter)||info.newCounter<0||((counter>0||info.newCounter>0)&&info.newCounter<=counter))throw failure(400);
    const current=this.db.prepare('SELECT * FROM passkey_credentials WHERE id=?').get(stored.id);
    if(!current||current.counter!==counter||!Buffer.from(current.public_key).equals(publicKey))throw failure();
    const updated=this.db.prepare('UPDATE passkey_credentials SET counter=?,last_used_at=?,device_type=?,backed_up=? WHERE id=? AND counter=? AND public_key=? AND (SELECT version FROM passkey_owner WHERE id=1)=?').run(info.newCounter,this.now(),info.credentialDeviceType,info.credentialBackedUp?1:0,stored.id,counter,publicKey,item.version);
    if(updated.changes!==1)throw failure();
    return{verified:true};
  }
  async verifyRegistration(ticket,browserToken,response,{label}={}){
    const item=this.#ticket(ticket,browserToken,'register',{consume:true});this.#response(response);
    if(label!==undefined&&(typeof label!=='string'||label.length>80||/[\x00-\x1f\x7f]/.test(label)))throw failure(400);
    const displayLabel=typeof label==='string'&&label.trim()?label.trim():item.label;
    let result;
    try{result=await this.webAuthn.verifyRegistrationResponse({response,expectedChallenge:item.challenge,expectedOrigin:this.rpOrigin,expectedRPID:this.rpID,requireUserPresence:true,requireUserVerification:true,supportedAlgorithmIDs:[-7,-257]});}catch{throw failure(400);}
    this.#snapshot(item);
    const info=result?.registrationInfo,credential=info?.credential;
    if(!result?.verified||!info?.userVerified||info.origin!==this.rpOrigin||info.rpID!==this.rpID||!credential||!canonicalID(credential.id)||credential.id!==response.id||!(credential.publicKey instanceof Uint8Array)||!credential.publicKey.length||!Number.isSafeInteger(credential.counter)||credential.counter<0)throw failure(400);
    return this.#transaction(()=>{
      if(this.db.prepare('SELECT 1 FROM passkey_credentials WHERE id=?').get(credential.id))throw failure(409);
      if(this.db.prepare('UPDATE passkey_owner SET version=version+1 WHERE id=1 AND version=?').run(item.version).changes!==1)throw failure();
      this.db.prepare('INSERT INTO passkey_credentials(id,public_key,counter,transports,label,created_at,last_used_at,device_type,backed_up) VALUES(?,?,?,?,?,?,NULL,?,?)').run(credential.id,Buffer.from(credential.publicKey),credential.counter,JSON.stringify(transportList(credential.transports)),displayLabel,this.now(),info.credentialDeviceType,info.credentialBackedUp?1:0);
      return{verified:true};
    });
  }
  remove(id){
    if(!canonicalID(id))throw failure(400);
    return this.#transaction(()=>{
      if(!this.db.prepare('SELECT 1 FROM passkey_credentials WHERE id=?').get(id))throw failure(400);
      if(this.count()<=1)throw failure(409);
      this.db.prepare('DELETE FROM passkey_credentials WHERE id=?').run(id);this.db.prepare('UPDATE passkey_owner SET version=version+1 WHERE id=1').run();return{removed:true};
    });
  }
}
