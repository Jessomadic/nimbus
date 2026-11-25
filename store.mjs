// Private additive schema kernel; caller owns the database connection.
export function installStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, definition TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, next INTEGER, attempts INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY, job TEXT NOT NULL, fire_key TEXT NOT NULL, trigger TEXT NOT NULL, due INTEGER, status TEXT NOT NULL, started INTEGER NOT NULL, ended INTEGER, output TEXT, error TEXT, UNIQUE(job,fire_key));
  CREATE UNIQUE INDEX IF NOT EXISTS one_active ON executions(job) WHERE status='running';`);
  return {
    importHermes(source,provenance) {
      const id='hermes:'+source.id;
      const definition=JSON.stringify({imported:true,sourceOwner:'Hermes',source,provenance,activation:'blocked_pending_explicit_cutover'});
      db.exec('SAVEPOINT import_identity');
      try {
        db.prepare('INSERT INTO jobs(id,definition,enabled,next) VALUES(?,?,0,NULL) ON CONFLICT(id) DO NOTHING').run(id,definition);
        const existing=db.prepare('SELECT definition FROM jobs WHERE id=?').get(id);
        if(existing.definition!==definition) throw Error('Import identity conflict');
        db.exec('RELEASE import_identity');
      } catch(e) {db.exec('ROLLBACK TO import_identity; RELEASE import_identity');throw e;}
      return {id,enabled:false};
    }
  };
}
