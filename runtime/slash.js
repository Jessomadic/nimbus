// Local slash commands for a worker chat, adapted from the parent project's Claude
// Code commands. They run on the host and never start a model turn, so they use
// neither the OpenAI nor the Claude subscription. /compact is handled separately.
import fs from 'node:fs';
import path from 'node:path';
import {rankCandidates,isClaudeTier} from './provider-catalog.js';

export const TIERS=['auto','local','luna','terra','sol','astra','claude-haiku','claude-sonnet','claude-opus','claude-fable'];
export const EFFORT_LEVELS=['low','medium','high','xhigh','max'];
export const SLASH_COMMANDS=[
  ['/help','List the local commands'],
  ['/model','Show or set this worker\'s model: /model auto | local | luna | terra | sol | astra | claude-haiku | claude-sonnet | claude-opus | claude-fable'],
  ['/effort','Show or set reasoning effort: /effort low | medium | high | xhigh | max'],
  ['/providers','Show the evidence-ranked models for this worker\'s role, best first'],
  ['/usage','Show the OpenAI and Claude subscription status'],
  ['/context','Show what is using this chat\'s context'],
  ['/stop','Stop this worker\'s running task in this chat'],
  ['/rename','Rename this worker: /rename New name'],
];
const ACTIVE="('queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input')";
const roleText=bot=>[bot.template,bot.name,bot.role].filter(Boolean).join(' — ');

export function isLocalSlash(text){
  const name=String(text||'').trim().split(/\s+/)[0].toLowerCase();
  return SLASH_COMMANDS.some(([command])=>command===name);
}
export function contextBreakdown({query,botId,thread,dataDir,settings}){
  const dir=path.join(dataDir,'bots',String(botId)),size=file=>{try{return fs.readFileSync(path.join(dir,file),'utf8').length;}catch{return 0;}};
  const history=query('SELECT messages FROM worker_history WHERE bot_id=? AND thread=?').get(botId,thread);
  let messages=[];try{messages=history?JSON.parse(history.messages):[];}catch{}
  const parts={instructions:size('AGENTS.md'),memory:size('MEMORY.md'),user:0,assistant:0,tool:0};
  for(const m of messages){const n=typeof m.content==='string'?m.content.length:JSON.stringify(m.content??'').length;parts[m.role==='tool'?'tool':m.role==='assistant'?'assistant':'user']+=n;}
  const total=Object.values(parts).reduce((a,b)=>a+b,0),limit=settings.maxHistoryChars;
  return {parts,total,limit,messages:messages.length,percent:Math.round(total/limit*100),estimatedTokens:Math.round(total/4)};
}
// Returns the note text to post, or throws with statusCode for user errors.
export async function runLocalSlash(text,{query,bot,thread,dataDir,settings,stopRun,providerStatus}){
  const [name,...rest]=String(text).trim().split(/\s+/),arg=rest.join(' ').trim(),command=name.toLowerCase();
  const bad=message=>Object.assign(new Error(message),{statusCode:400});
  if(command==='/help')return 'Local commands (no model is used):\n'+SLASH_COMMANDS.map(([c,d])=>`${c} — ${d}`).join('\n')+'\n/compact — Compress context and archive full history';
  if(command==='/model'){
    if(!arg)return `Model: ${bot.model||'auto'} (role preference ${bot.default_model||'none'}).`;
    if(!TIERS.includes(arg))throw bad('Unknown model. Choose one of: '+TIERS.join(', '));
    query('UPDATE bots SET model=? WHERE id=?').run(arg,bot.id);
    return `Model set to ${arg}${arg==='auto'?' (best ranked model for the role, then next best)':isClaudeTier(arg)?' (Claude subscription)':arg==='local'?' (shared local model)':' (OpenAI subscription)'}.`;
  }
  if(command==='/effort'){
    if(!arg)return `Effort: ${bot.effort||'medium'}.`;
    if(!EFFORT_LEVELS.includes(arg))throw bad('Effort must be one of: '+EFFORT_LEVELS.join(', '));
    query('UPDATE bots SET effort=? WHERE id=?').run(arg,bot.id);return `Effort set to ${arg}.`;
  }
  if(command==='/providers'){
    const {openai,claude}=await providerStatus();
    const ranking=rankCandidates({role:roleText(bot),preferredTier:bot.default_model||'',available:t=>isClaudeTier(t)?claude.ok:openai.ok});
    const all=rankCandidates({role:roleText(bot),preferredTier:bot.default_model||''});
    return `Role category: ${ranking.category} (${ranking.basis} ranking).\nAvailable now, best first: ${ranking.candidates.join(' → ')||'none'}.\nFull ranking: ${all.candidates.join(' → ')}.`;
  }
  if(command==='/usage'){
    const {openai,claude}=await providerStatus();
    const windows=[openai.limits?.rateLimits?.primary,openai.limits?.rateLimits?.secondary].filter(Boolean).map(w=>`${Math.max(0,Math.round(100-w.usedPercent))}% left`).join(', ');
    return `OpenAI: ${openai.subscription?`connected${openai.plan?' ('+openai.plan+')':''}${windows?' · '+windows:''}`:'sign-in required'}.\nClaude: ${!claude.enabled?'disabled':claude.limited?'usage limit reached':claude.ok?`connected (${claude.mode==='token'?'saved token':'Claude Code login'}${claude.plan?', '+claude.plan:''})`:'not connected'}.`;
  }
  if(command==='/context'){
    const b=contextBreakdown({query,botId:bot.id,thread,dataDir,settings});
    const row=(label,n)=>`${label}: ${n.toLocaleString()} chars`;
    return `Context ${b.percent}% of ${b.limit.toLocaleString()} characters (about ${b.estimatedTokens.toLocaleString()} tokens, ${b.messages} retained messages).\n`+
      [row('Instructions',b.parts.instructions),row('Memory',b.parts.memory),row('Your messages',b.parts.user),row('Replies',b.parts.assistant),row('Tool results',b.parts.tool)].join('\n')+
      (b.percent>=75?'\nUse /compact to archive older history.':'');
  }
  if(command==='/stop'){
    const runs=query(`SELECT id FROM runs WHERE bot_id=? AND thread=? AND status IN ${ACTIVE}`).all(bot.id,thread);
    for(const r of runs)stopRun(r.id);
    return runs.length?`Stop requested for task ${runs.map(r=>'#'+r.id).join(', ')}.`:'Nothing is running in this chat.';
  }
  if(command==='/rename'){
    if(!arg||arg.length>60)throw bad('Use /rename followed by a name of up to 60 characters.');
    query('UPDATE bots SET name=? WHERE id=?').run(arg,bot.id);return `Renamed to ${arg}.`;
  }
  throw bad('Unknown command');
}
