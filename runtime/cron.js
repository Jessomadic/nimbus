// Pure cron parsing shared by the scheduler and worker tools.
function fieldMatches(field, value, min, max) {
  return field.split(',').some((part) => {
    let [range, step] = part.split('/');
    step = step ? Number(step) : 1;
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) [lo, hi] = range.split('-').map(Number);
    else { lo = hi = Number(range); if (part.includes('/')) hi = max; }
    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
  });
}

export function cronMatches(expr, d) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const [mi, h, dom, mon, dow] = f;
  const dowVal = d.getDay();
  const domOk = fieldMatches(dom, d.getDate(), 1, 31);
  const dowOk = fieldMatches(dow, dowVal, 0, 7) || (dowVal === 0 && fieldMatches(dow, 7, 0, 7));
  const dayOk = dom !== '*' && dow !== '*' ? domOk || dowOk : domOk && dowOk;
  return fieldMatches(mi, d.getMinutes(), 0, 59) && fieldMatches(h, d.getHours(), 0, 23) && fieldMatches(mon, d.getMonth() + 1, 1, 12) && dayOk;
}

export function isValidCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  const limits=[[0,59],[0,23],[1,31],[1,12],[0,7]];
  return f.length===5&&f.every((field,index)=>field.split(',').every(part=>{
    const match=part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);if(!match||match[2]&&Number(match[2])<1)return false;
    if(match[1]==='*')return true;
    const values=match[1].split('-').map(Number),[min,max]=limits[index];
    return values.every(v=>v>=min&&v<=max)&&(values.length===1||values[0]<=values[1]);
  }));
}

export function nextRun(expr, from = new Date()) {
  if (!isValidCron(expr)) return null;
  const d = new Date(from);
  d.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 8; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (cronMatches(expr, d)) return d;
  }
  return null;
}
