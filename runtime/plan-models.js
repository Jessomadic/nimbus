// Which model tiers the connected subscriptions actually include. Workers are
// only routed to these; anything else is treated as unavailable.
import {resolveCloudModel} from './model-selection.js';
import {OPENAI_TIER_NAMES,CLAUDE_TIER_NAMES} from './provider-catalog.js';

// Claude plans (Claude Code subscription login). Sources: Anthropic support
// "Use Claude Code with your Pro or Max plan" and "What is the Pro plan?"
// (Max and Ultra list a separate weekly Fable limit), plus a live check on
// 2026-11-24 where a Pro login refused claude-fable-5-2. An unknown plan gets
// the Pro set so a refused model is never offered by default.
export const CLAUDE_PLAN_TIERS={
  pro:['claude-haiku','claude-sonnet','claude-opus'],
  max:CLAUDE_TIER_NAMES,
  ultra:CLAUDE_TIER_NAMES,
  team:CLAUDE_TIER_NAMES,
  enterprise:CLAUDE_TIER_NAMES,
};
export function claudePlanTiers(plan,c){
  const key=String(plan||'').toLowerCase().replace(/[^a-z]/g,'');
  const base=CLAUDE_PLAN_TIERS[Object.keys(CLAUDE_PLAN_TIERS).find(k=>key.startsWith(k))]||CLAUDE_PLAN_TIERS.pro;
  // claude.planTiers in nimbus.config.json overrides the table for this account.
  const override=Array.isArray(c?.claude?.planTiers)&&c.claude.planTiers.length?c.claude.planTiers:null;
  const disabled=new Set(c?.claude?.disabledTiers||[]);
  return (override||base).filter(t=>CLAUDE_TIER_NAMES.includes(t)&&!disabled.has(t));
}
// OpenAI tiers the signed-in Codex account's live model catalog can resolve.
export function openaiCatalogTiers(status,c){
  if(!status?.models?.length)return [];
  return OPENAI_TIER_NAMES.filter(tier=>{try{resolveCloudModel(tier,status,c);return true;}catch{return false;}});
}
