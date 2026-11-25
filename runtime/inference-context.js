const DEFAULT_TOOL_CHARS=12000;
const PARTIAL_NOTE='Partial inference preview only. The full canonical tool result is retained by Nimbus; use a targeted read or the action journal before claiming complete inspection.';

function characterLimit(value,label){
  const limit=value===undefined?DEFAULT_TOOL_CHARS:value;
  if(!Number.isSafeInteger(limit)||limit<256||limit>1000000)throw new RangeError(`${label} must be an integer from 256 to 1000000`);
  return limit;
}
function boundedText(text,maxChars){
  if(text.length<=maxChars)return text;
  const preview=length=>JSON.stringify({truncated:true,originalCharacters:text.length,preview:text.slice(0,length),notice:PARTIAL_NOTE});
  // JSON escaping can expand the preview. Bound the complete serialized result,
  // not just the raw prefix; keep it valid JSON even at the limit.
  let low=0,high=Math.min(text.length,maxChars);
  while(low<high){const middle=Math.ceil((low+high)/2);if(preview(middle).length<=maxChars)low=middle;else high=middle-1;}
  return preview(low);
}

// Model-only text for one tool result. Small results keep their exact JSON;
// large results become an explicitly partial, valid JSON preview. The input is
// never modified. Numeric maxChars is accepted as a shorthand for the options.
export function toolResultText(result,options={}){
  const maxChars=characterLimit(typeof options==='number'?options:options?.maxChars,'maxChars');
  return boundedText(JSON.stringify(result??null),maxChars);
}

// Canonical history/journals remain complete. Only string content on tool
// messages in this cloned inference view is bounded. User/system instructions,
// assistant tool arguments and call IDs are retained byte-for-byte.
export function boundedInferenceMessages(messages,{maxToolChars=DEFAULT_TOOL_CHARS}={}){
  if(!Array.isArray(messages))throw new TypeError('Inference messages must be an array');
  const limit=characterLimit(maxToolChars,'maxToolChars'),copy=structuredClone(messages);
  for(const message of copy)if(message?.role==='tool'&&typeof message.content==='string')message.content=boundedText(message.content,limit);
  return copy;
}

// Fit the aggregate history, not just each individual tool result. Keep every
// user instruction, ordinary reply and unfinished/uncertain exchange verbatim.
// Older completed exchanges can leave the inference view as intact pairs; their
// exact arguments/results stay in the canonical checkpoint and action journal.
export function fitInferenceMessages(messages,{maxChars=240000,maxToolChars=DEFAULT_TOOL_CHARS}={}){
  if(!Number.isSafeInteger(maxChars)||maxChars<256)throw new RangeError('maxChars must be an integer of at least 256');
  const copy=boundedInferenceMessages(messages,{maxToolChars});
  if(JSON.stringify(copy).length<=maxChars)return copy;
  const groups=[];
  for(let i=0;i<copy.length;i++){
    const calls=copy[i]?.role==='assistant'&&copy[i].tool_calls;
    if(!calls?.length)continue;
    const results=copy.slice(i+1,i+1+calls.length);
    const ids=new Set(calls.map(call=>call.id));
    if(ids.size!==calls.length||results.length!==calls.length||results.some(result=>result.role!=='tool'||!ids.delete(result.tool_call_id))||ids.size)continue;
    const evidence=results.map((result,offset)=>{
      try{return JSON.parse(messages[i+1+offset].content);}catch{return null;}
    });
    if(evidence.some(result=>result?.uncertain))continue;
    groups.push({start:i,end:i+calls.length,calls:calls.map(call=>{
      const result=results.find(result=>result.tool_call_id===call.id);
      let outcome;try{const parsed=JSON.parse(messages[i+1+results.indexOf(result)].content);outcome=parsed?.error||parsed?.denied?'error':'returned';}catch{outcome='returned';}
      return{id:call.id,name:call.function?.name,outcome};
    })});
    i+=calls.length;
  }
  const omitted=new Set(),index=[];
  let first;
  const render=()=>copy.flatMap((message,i)=>{
    const notice=i===first?[{role:'assistant',content:'Partial inference history: earlier completed tool exchanges are indexed below. Full exact arguments and results remain in Nimbus canonical checkpoints and the action journal; use task_history or a targeted evidence read when details are needed. These are retained outcomes, not actions to replay. No user instructions were removed.\n'+JSON.stringify(index)}]:[];
    return omitted.has(i)?notice:[...notice,message];
  });
  for(const group of groups){
    first??=group.start;
    for(let i=group.start;i<=group.end;i++)omitted.add(i);
    index.push(...group.calls);
    const view=render();
    if(JSON.stringify(view).length<=maxChars)return view;
  }
  throw Object.assign(new Error('Retained user instructions, replies or unfinished actions exceed model context capacity. Full work is retained; a larger-context model or an explicit narrower task is required.'),{code:'inference_context_capacity'});
}

export function inferenceView(messages,settings,{maxChars=settings.maxHistoryChars}={}){
  const options={maxChars:Math.min(maxChars,settings.maxHistoryChars),maxToolChars:settings.maxToolChars};
  if(settings.automaticCompression)return fitInferenceMessages(messages,options);
  const copy=boundedInferenceMessages(messages,options);
  if(JSON.stringify(copy).length>options.maxChars)throw new Error('Model context capacity exceeded. Use /compact or enable automatic compression in Nimbus settings. Full work is retained.');
  return copy;
}
