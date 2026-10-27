import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));

export class SessionStore{
  constructor({db,binding,now=()=>Math.floor(Date.now()/1000),absoluteSeconds=86400,idleSeconds=28800}){
    this.db=db;this.binding=binding;this.now=now;this.absoluteSeconds=absoluteSeconds;this.idleSeconds=idleSeconds;
    db.exec("CREATE TABLE IF NOT EXISTS auth_sessions(token TEXT PRIMARY KEY,created_at INTEGER DEFAULT(unixepoch()),email TEXT DEFAULT '',binding TEXT NOT NULL,last_seen INTEGER NOT NULL)");
    const columns=new Set(db.prepare('PRAGMA table_info(auth_sessions)').all().map(c=>c.name));
    if(!columns.has('email'))db.exec("ALTER TABLE auth_sessions ADD COLUMN email TEXT DEFAULT ''");
    if(!columns.has('binding')){
      // Legacy rows contained bearer tokens and had no credential binding. A
      // one-time sign-in is required instead of trusting those old sessions.
      db.exec("DELETE FROM auth_sessions; ALTER TABLE auth_sessions ADD COLUMN binding TEXT NOT NULL DEFAULT ''");
    }
    if(!columns.has('last_seen'))db.exec('ALTER TABLE auth_sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0');
    db.prepare('DELETE FROM auth_sessions WHERE created_at<=? OR last_seen<=?').run(now()-absoluteSeconds,now()-idleSeconds);
  }
  issue(email=''){
    const binding=this.binding(email);if(!binding)throw new Error('This login identity is no longer enabled');
    const token=randomBytes(32).toString('hex'),now=this.now();
    this.db.prepare('INSERT INTO auth_sessions(token,created_at,email,binding,last_seen) VALUES(?,?,?,?,?)').run(digest(token),now,email,binding,now);return token;
  }
  authenticate(token,{touch=true}={}){
    if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;
    const key=digest(token),row=this.db.prepare('SELECT * FROM auth_sessions WHERE token=?').get(key);if(!row)return null;
    const now=this.now(),current=this.binding(row.email);
    if(now-row.created_at>=this.absoluteSeconds||now-row.last_seen>=this.idleSeconds||!current||!equal(current,row.binding)){
      this.db.prepare('DELETE FROM auth_sessions WHERE token=?').run(key);return null;
    }
    if(touch)this.db.prepare('UPDATE auth_sessions SET last_seen=? WHERE token=?').run(now,key);
    return{email:row.email,createdAt:row.created_at,lastSeen:row.last_seen};
  }
  revoke(token){if(typeof token==='string')this.db.prepare('DELETE FROM auth_sessions WHERE token=?').run(digest(token));}
}

// Reservations are committed synchronously before awaiting any request body,
// and survive process restart. Callers reset each bucket only after proving its
// factor: password success clears password buckets, full sign-in clears factors.
export class LoginThrottle{
  constructor({db,now=()=>Math.floor(Date.now()/1000)}){this.db=db;this.now=now;db.exec('CREATE TABLE IF NOT EXISTS auth_attempts(bucket TEXT PRIMARY KEY,attempts INTEGER NOT NULL,until_at INTEGER NOT NULL)');}
  reserve(bucket,{limit=8,windowSeconds=900}={}){
    const key=digest(bucket),now=this.now(),row=this.db.prepare('SELECT * FROM auth_attempts WHERE bucket=?').get(key);
    if(row&&row.until_at>now&&row.attempts>=limit)return{allowed:false,retryAfter:row.until_at-now};
    this.db.prepare('INSERT INTO auth_attempts VALUES(?,?,?) ON CONFLICT(bucket) DO UPDATE SET attempts=excluded.attempts,until_at=excluded.until_at').run(key,row&&row.until_at>now?row.attempts+1:1,row&&row.until_at>now?row.until_at:now+windowSeconds);
    this.db.prepare('DELETE FROM auth_attempts WHERE until_at<=?').run(now);return{allowed:true};
  }
  clear(bucket){this.db.prepare('DELETE FROM auth_attempts WHERE bucket=?').run(digest(bucket));}
}
