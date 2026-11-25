// Service-manual requests (port of Hermes agent/lumos_manual_policy.py detection).
// Owner decision 2026-11-25: on Nimbus these run on Claude Opus at medium effort
// (Hermes required GPT-6 Astra xhigh, which the current ChatGPT plan lacks).
const EXPLICIT=/@service-manual\b|field-service-manuals|\b(?:field\s+service|service|repair|maintenance)\s+(?:manuals?|guides?)\b/i;
const BUILD=/\b(?:make|create|write|build|generate|revise|update|finish|continue|resume|resuming|edit|editing|restart|reopen|finalize|complete)\b/i;
const DEVICE=/\b(?:printer|laptop|computer|server|appliance|HVAC|device|product|HP|E786|ThinkPad|Epson|TM-H6000V)\b/i;
const DOCUMENT=/\b(?:guides?|manuals?|documents?|docs?)\b/i;
const CONTINUE=/\b(?:it|that|those|them|same|continue|resume|resuming|edit|editing|restart|reopen|again|manual|guide|document|diagram|illustration|figure|caption|pointer|screw|connector|page|source|video|photo|picture)\b/i;
const INGEST=/\b(?:re[- ]?)?(?:ingest|injest|index|transcribe)(?:ing|ion)?\b/i;
const AUTHOR=/\b(?:make|create|write|build|generate|revise|edit|author|publish|illustrate|update|finish|complete|correct|fix)\b|\b(?:how to|steps to|instructions for|walk me through)\b|@service-manual/i;
const RESEARCH=/\b(?:research|find|locate|discover|collect|look up|source discovery)\b/i;
const SOURCES=/\b(?:sources?|documentation|documents?|manuals?|guides?|URLs?|PDFs?|videos?)\b/i;
const NO_AUTHOR=/\b(?:do not|don't|never)\s+(?:perform local file changes or\s+)?(?:write|create|build|generate|revise|edit|author|publish|illustrate)\s+(?:(?:a|an|the|any)\s+)?(?:(?:field service|service|repair|maintenance)\s+)?(?:manuals?|guides?|documents?)\b/gi;
const ACKS=['yes','ok','okay','go ahead','do it','please do'];

export const MANUAL_ROUTE={tier:'claude-opus',effort:'medium'};
const direct=v=>EXPLICIT.test(v)||BUILD.test(v)&&DEVICE.test(v)&&DOCUMENT.test(v);
const ingestionOnly=v=>INGEST.test(v)&&!AUTHOR.test(v);
function evidenceOnly(v){
  if(ingestionOnly(v))return true;
  const positive=v.replace(NO_AUTHOR,'');
  return RESEARCH.test(positive)&&SOURCES.test(positive)&&!AUTHOR.test(positive)&&!BUILD.test(positive)&&!v.toLowerCase().includes('@service-manual');
}
const ack=v=>ACKS.includes(v.toLowerCase().trim().replace(/[.!?]+$/,''));
// message: the owner's text; history: earlier owner messages in this topic, oldest first.
export function serviceManualRequested(message,history=[]){
  const value=String(message||'').trim();
  if(evidenceOnly(value))return false;
  if(direct(value))return true;
  if(!(CONTINUE.test(value)||DEVICE.test(value)||ack(value)))return false;
  for(const prior of history.slice(-12).reverse().map(String)){
    if(evidenceOnly(prior))return false;
    if(direct(prior))return true;
    if(!(CONTINUE.test(prior)||ack(prior)))return false;
  }
  return false;
}
