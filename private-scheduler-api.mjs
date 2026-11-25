// Explicit host composition; not registered with production HTTP or tools.
export function registerPrivateScheduler({db,owner,port,now=Date.now}){
 if(!owner||!port)throw Error('host binding required');
 const q=s=>db.prepare(s);
 return Object.freeze({
 create({id,botId,prompt,due,interval=null}){if(typeof id!=='string'||!id.startsWith('owned:')||!Number.isSafeInteger(botId)||typeof prompt!=='string'||!prompt.trim()||!Number.isSafeInteger(due)||(interval!==null&&(!Number.isSafeInteger(interval)||interval<1)))throw Error('invalid owned schedule');
 db.exec('SAVEPOINT scheduler_create');try{q('INSERT INTO jobs(id,definition,enabled,next) VALUES(?,?,1,?)').run(id,JSON.stringify({botId,prompt,interval}),due);q('INSERT INTO dispatch_policy VALUES(?,?,0)').run(id,owner);db.exec('RELEASE scheduler_create');}catch(e){db.exec('ROLLBACK TO scheduler_create; RELEASE scheduler_create');throw e;}},
 async tick(){const id=port.claim();if(!id)return null;const row=q('SELECT o.job,o.due,j.definition FROM dispatch_occurrences o JOIN jobs j ON j.id=o.job WHERE o.id=?').get(id);const d=JSON.parse(row.definition);if(d.interval&&!port.advanceCursor(id,Math.max(row.due+d.interval,now()+d.interval)))throw Error('cursor held');await port.launch(id);return id;},
 observe:port.observe,recover:port.recover
 });
}
