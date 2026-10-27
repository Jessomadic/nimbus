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
