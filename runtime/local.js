import { config } from './config.js';
import { localToken } from './credentials.js';
import { localSlots } from './slots.js';
import { checkResources } from './resources.js';
import { imageData, retainedImages } from './workbench.js';
import {inferenceView} from './inference-context.js';

export async function localChat(messages, { model, tools, jsonSchema, signal, guard = checkResources, c = config(), getConfig = config } = {}) {
  // Task configuration may predate an owner's toggle. Never interrupt an in-flight
  // request, but recheck eligibility at every new dispatch and after queue waits.
  const requireEnabled=()=>{if(!c.local.enabled||!getConfig().local.enabled)throw new Error('Local inference is disabled');};
  requireEnabled();
  return localSlots.use(signal, async () => {
    requireEnabled();
    await guard(c.local.resourceCeiling);
    requireEnabled();
    const token = await localToken(c.local);
    const catalog = await localCatalog(c);
    const loaded = catalog.models.find(m => m.loaded && (c.local.approvedModels.includes(m.id) || c.local.reuseLoaded && m.toolCapable === true));
    const selected = model || loaded?.id || c.local.model;
    const entry=catalog.models.find(m=>m.id===selected);
    const capacities=[c.local.contextTokens,entry?.contextTokens,...(entry?.instances||[]).map(instance=>instance.context)].filter(value=>Number.isFinite(value)&&value>0);
    const contextTokens=Math.min(...capacities);
    const reserve=jsonSchema?512:4096;
    const maxChars=Math.floor(Math.min(c.context.maxHistoryChars,(contextTokens-reserve)*2.5)-(tools?.length?JSON.stringify(tools).length:0)-1024);
    if(maxChars<256)throw new Error('The selected loaded model does not have enough context capacity for instructions, tools and output; checkpoint retained.');
    const inference=inferenceView(messages,c.context,{maxChars});
    const visual=[];
    const retainedCallIds=new Set(inference.filter(message=>message.role==='tool').map(message=>message.tool_call_id));
    for(const result of retainedImages(messages.filter(message=>message.role==='tool'&&retainedCallIds.has(message.tool_call_id)))){
      try{visual.push({role:'user',content:[{type:'text',text:'Pixels returned by the retained Nimbus image tool: '+result.image.path},{type:'image_url',image_url:{url:imageData(result)}}]});}
      catch{visual.push({role:'user',content:'A retained image changed or is unavailable. Use view_image again before making visual claims.'});}
    }
    const body = { model: selected, messages:[...inference,...visual], stream: false, temperature: 0.2, max_tokens: reserve };
    if (tools?.length) body.tools = tools;
    if (jsonSchema) body.response_format = { type: 'json_schema', json_schema: { name: 'nimbus_route', strict: true, schema: jsonSchema } };
    const timeout = AbortSignal.timeout(c.local.timeoutSeconds * 1000);
    requireEnabled();
    const response = await fetch(c.local.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!response.ok) throw new Error(`Local inference failed (${response.status}): ${(await response.text()).slice(0, 600)}`);
    const data = await response.json();
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('The local model returned no assistant message');
    if (data.choices[0].finish_reason === 'length') throw new Error('The local response exceeded its output budget; task checkpoint retained');
    return { message, usage: data.usage || {}, model: data.model || body.model, contextTokens };
  });
}
export async function localCatalog(c = config()) {
  try {
    const token = await localToken(c.local);
    const url = new URL(c.local.baseUrl); url.pathname = '/api/v1/models';
    const r = await fetch(url, { redirect: 'error', headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`Catalog returned ${r.status}`);
    const data = await r.json();
    return { ok: true, models: (data.models || []).map(m => ({ id: m.key, toolCapable:m.tool_capable, contextTokens:m.max_context_length, loaded: (m.loaded_instances || []).length > 0,
      instances: (m.loaded_instances || []).map(i => ({ id: i.identifier || i.id, context: i.config?.context_length })) })) };
  } catch (e) { return { ok: false, models: [], error: e.message }; }
}
