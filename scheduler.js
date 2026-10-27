// Minimal 5-field cron: "min hour day-of-month month day-of-week".
// Supports *, numbers, ranges (1-5), lists (1,3,5) and steps (*/15, 9-17/2).
import { q } from './db.js';
import { runBot, addMessage } from './runner.js';

export {cronMatches,isValidCron,nextRun} from './runtime/cron.js';
import {cronMatches} from './runtime/cron.js';

export function startScheduler() {
  let lastMinute = -1;
  setInterval(async () => {
    const now = new Date();
    const stamp = Math.floor(now.getTime() / 60000);
    if (stamp === lastMinute) return;
    lastMinute = stamp;
    const due = q('SELECT * FROM routines WHERE enabled=1').all().filter((r) => cronMatches(r.cron, now));
    if (!due.length) return;
    for (const r of due) {
      if(r.last_run&&Math.floor(r.last_run/60)===Math.floor(now.getTime()/60000))continue;
      if (q("SELECT id FROM runs WHERE bot_id=? AND source='schedule' AND status IN ('queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input','waiting_tool','paused') LIMIT 1").get(r.bot_id)) continue;
      q('UPDATE routines SET last_run=unixepoch() WHERE id=?').run(r.id);
      runBot({ botId: r.bot_id, thread: 'bot:' + r.bot_id, prompt: r.prompt, source: 'schedule', quiet: !!r.quiet });
    }
  }, 15000).unref();
}
