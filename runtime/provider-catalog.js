// Evidence-ranked provider/model choice per role, across the OpenAI (Codex) and
// Claude (Claude Code) subscriptions. The router starts from the first available
// candidate for a role and falls back down the same list. Override any category
// with routing.providerRanking in nimbus.config.json.
//
// Evidence, retrieved 2026-11-24 (third-party and vendor-reported; harnesses differ):
// - Agentic coding: Claude Opus 5.5 leads SWE-bench Pro (89.9%, vendor-aggregated);
//   Sonnet 5.5 81.3%. Terminal-Bench 4.0 is close (Artificial Analysis: GPT-6.2 Sol
//   60.1 vs Opus 59.6; Vals AI mini-SWE-agent: Opus 65.15 vs Sol 60.61).
//   https://www.morphllm.com/swe-bench-pro  https://benchlm.ai/compare/claude-opus-5-5-vs-gpt-6-2-sol
// - Composite index: Opus 5.5 58.0 vs GPT-6.2 Sol 53.9; Sol about half the per-token cost.
//   https://llm-stats.com/models/compare/claude-opus-5-5-vs-gpt-6.2-sol
// - Claude Fable 5.2 is Anthropic's most capable widely released model for long-horizon
//   reasoning (Anthropic model documentation).
// Orderings for research, writing, operations and orchestration are inferred from those
// results plus each tier's documented purpose; no head-to-head benchmark was found for
// the Luna/Terra tiers or for Haiku 5.5, so they are ordered by cost class.
export const CLAUDE_TIER_NAMES=['claude-haiku','claude-sonnet','claude-opus','claude-fable'];
export const OPENAI_TIER_NAMES=['luna','terra','sol','astra'];
export const isClaudeTier=tier=>CLAUDE_TIER_NAMES.includes(tier);
export const isOpenAITier=tier=>OPENAI_TIER_NAMES.includes(tier);
export const providerOf=tier=>tier==='local'?'local':isClaudeTier(tier)?'anthropic':'openai';
export const backendOf=tier=>tier==='local'?'local':isClaudeTier(tier)?'claude':'codex';

// Capability class: 1 routine, 2 standard, 3 complex, 4 hardest.
export const TIER_CLASS={local:0,luna:1,'claude-haiku':1,terra:2,'claude-sonnet':2,sol:3,'claude-opus':3,astra:4,'claude-fable':4};

export const RANKING={
  engineering:   {basis:'sourced',  order:['claude-opus','sol','astra','claude-fable','claude-sonnet','terra','claude-haiku','luna']},
  architecture:  {basis:'sourced',  order:['claude-fable','claude-opus','astra','sol','claude-sonnet','terra']},
  security:      {basis:'inferred', order:['claude-fable','astra','claude-opus','sol','claude-sonnet','terra']},
  research:      {basis:'inferred', order:['astra','claude-opus','sol','claude-fable','claude-sonnet','terra','claude-haiku','luna']},
  content:       {basis:'inferred', order:['claude-opus','astra','claude-sonnet','sol','claude-fable','terra','claude-haiku','luna']},
  operations:    {basis:'inferred', order:['terra','claude-sonnet','sol','claude-opus','luna','claude-haiku','astra']},
  orchestration: {basis:'inferred', order:['sol','claude-opus','astra','claude-fable','claude-sonnet','terra']},
};
const ROLE_CATEGORY=[
  [/architect/i,'architecture'],[/security/i,'security'],
  [/orchestrat|coordinat/i,'orchestration'],
  [/research|analys|data|knowledge|curat/i,'research'],
  [/writ|document|design|content|teach/i,'content'],
  [/operat|automat|browser|office|windows|schedul|sync|push/i,'operations'],
  [/build|implement|review|test|qa|commit|pull request|ci |actions|engineer|code|fix/i,'engineering'],
];
export function roleCategory(role=''){
  for(const [pattern,category] of ROLE_CATEGORY)if(pattern.test(String(role)))return category;
  return 'engineering';
}
// Candidates ordered by closeness to the role's preferred capability class, then by
// the evidence ranking. The preferred class keeps routine roles on cheaper tiers.
export function rankCandidates({role,preferredTier='',available=()=>true,c}={}){
  const category=roleCategory(role),override=c?.routing?.providerRanking?.[category];
  const order=Array.isArray(override)&&override.length?override:RANKING[category].order;
  const target=TIER_CLASS[preferredTier]??3;
  const ranked=order.map((tier,index)=>({tier,index,distance:Math.max(0,target-TIER_CLASS[tier])*2+Math.max(0,TIER_CLASS[tier]-target)}))
    .filter(item=>TIER_CLASS[item.tier]!=null&&item.tier!=='local'&&available(item.tier))
    .sort((a,b)=>a.distance-b.distance||a.index-b.index).map(item=>item.tier);
  return {category,basis:Array.isArray(override)&&override.length?'configured':RANKING[category].basis,candidates:ranked};
}
