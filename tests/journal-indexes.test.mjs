import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ensureJournalIndexes} from '../runtime/journal-indexes.js';

test('journal recovery lookups use indexes and migration preserves retained state', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE runs(id INTEGER PRIMARY KEY,status TEXT,parent_run INTEGER,checkpoint TEXT);
      CREATE TABLE tool_calls(id TEXT PRIMARY KEY,run_id INTEGER,name TEXT,state TEXT,args TEXT,result TEXT);
      INSERT INTO runs VALUES(1206,'needs_review',1169,'retained checkpoint');
      INSERT INTO tool_calls VALUES('held',1206,'git_diff','uncertain','exact arguments','exact error');
      INSERT INTO tool_calls VALUES('finished',1206,'read_file','done','retained arguments','retained result');
    `);
    const rows = () => ({runs:db.prepare('SELECT * FROM runs ORDER BY id').all(),calls:db.prepare('SELECT * FROM tool_calls ORDER BY id').all()});
    const before = rows();
    ensureJournalIndexes(db);
    ensureJournalIndexes(db);
    assert.deepEqual(rows(),before);
    const checks = [
      ["SELECT id,name,state FROM tool_calls WHERE run_id=1206 AND state IN ('running','uncertain')",'tool_calls_run_state'],
      ["SELECT id FROM tool_calls WHERE run_id=1206 AND name='project_recovery' AND state='running'",'tool_calls_run_state'],
      ["SELECT id,status FROM runs WHERE status IN ('queued','running','waiting_input') ORDER BY id LIMIT 100",'runs_status_id'],
      ['SELECT id FROM runs WHERE parent_run=1169','runs_parent_id'],
    ];
    for(const [sql,index] of checks) {
      const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all().map(row=>row.detail).join('\n');
      assert.ok(plan.includes(index),plan);
      assert.doesNotMatch(plan,/\bSCAN (?:runs|tool_calls)\b/);
    }
    assert.deepEqual(db.prepare("SELECT id FROM tool_calls WHERE run_id=1206 AND state IN ('running','uncertain')").all().map(row=>row.id),['held']);
  } finally { db.close(); }
});
