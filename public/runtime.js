export function createRuntimeUI(ctx) {
  const { api, esc, modal, closeModal, toast, bot, avatar, S, openThread, refreshState } = ctx;
  const fmt=n=>Number(n||0).toLocaleString();
  const statusLabels={waiting_tool:'Waiting for a new tool',waiting_input:'Waiting for your answer',needs_review:'Needs review',queued:'Queued',designing:'Designing',building:'Building',testing:'Testing',reviewing:'Reviewing',validating:'Validating',deploying:'Applying update',ready:'Ready',blocked:'Blocked',cancelled:'Cancelled'};
  const status=s=>`<span class="task-status ${esc(s)}">${esc(statusLabels[s]||String(s).replaceAll('_',' '))}</span>`;
  const requestPhases=[['designing','Design'],['building','Build'],['testing','Test'],['reviewing','Review'],['validating','Validate'],['deploying','Apply']];
  const phaseAliases={design:'designing',architect:'designing',build:'building',builder:'building',test:'testing',qa:'testing','qa-engineer':'testing',review:'reviewing',reviewer:'reviewing',validate:'validating',validation:'validating',deploy:'deploying',deployment:'deploying',applying:'deploying'};
  const requestArray=response=>Array.isArray(response?.requests)?response.requests:[];
  const positiveId=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
  const stageRole=role=>({'architect':'Architect','builder':'Builder','qa-engineer':'QA Engineer','reviewer':'Reviewer','security-reviewer':'Security Reviewer'}[String(role)]||String(role||'Worker').replaceAll('_',' ').replaceAll('-',' '));
  const phaseKey=value=>{const key=String(value||'').toLowerCase().replaceAll(' ','-');return phaseAliases[key]||key;};
  const terminalRequest=request=>['ready','cancelled'].includes(request.status);
  const requestNeedsAttention=request=>['blocked','needs_review'].includes(request.status);
  function replaceProgress(target,markup) {
    const active=document.activeElement,attribute=target.contains(active)?['data-tool-request','data-stage-task','data-task','data-group','data-chat'].find(name=>active.hasAttribute?.(name)):null,value=attribute?active.getAttribute(attribute):null;
    target.innerHTML=markup;
    if(attribute)[...target.querySelectorAll('button')].find(button=>button.getAttribute(attribute)===value)?.focus({preventScroll:true});
  }
  function requestCard(request,{compact=false,detail=false}={}) {
    const id=String(request.id),stages=Array.isArray(request.stages)?request.stages:[],current=phaseKey(request.phase||request.status),attention=requestNeedsAttention(request);
    const completed=new Set(stages.filter(stage=>stage.status==='done').map(stage=>phaseKey(stage.role)));
    const rail=compact?'':`<ol class="runtime-capability-phases" aria-label="Tool creation stages">${requestPhases.map(([key,label])=>{
      const done=request.status==='ready'||completed.has(key),active=!done&&current===key,state=done?'complete':active?attention?'attention':'current':'pending';
      return `<li class="${state}" ${active?'aria-current="step"':''}><span class="runtime-capability-phase-mark" aria-hidden="true">${done?'✓':active?'•':''}</span><span>${label}<span class="sr-only">: ${done?'complete':active?'current stage':'pending'}</span></span></li>`;
    }).join('')}</ol>`;
    return `<section class="runtime-capability-card ${compact?'compact':''} ${attention?'attention':''} ${request.status==='ready'?'ready':''}" data-capability-card="${esc(id)}">
      <div class="runtime-capability-heading"><div>${detail?`<h3 class="runtime-capability-title">${esc(request.title||request.tool_name||'New tool request')}</h3>`:`<button class="runtime-capability-title" data-tool-request="${esc(id)}">${esc(request.title||request.tool_name||'New tool request')}</button>`}${request.tool_name?`<small class="runtime-capability-name">${esc(request.tool_name)}</small>`:''}</div>${status(request.status||'queued')}</div>
      <p class="runtime-capability-message">${esc(request.message||(request.status==='ready'?'The tool is ready.':request.status==='queued'?'Waiting for an available worker.':request.status==='cancelled'?'This request was cancelled.':attention?'This request needs attention before work can continue.':'Preparing the next stage.'))}</p>
      ${rail}
      ${!compact&&stages.length?`<div class="runtime-capability-stages" aria-label="Worker task details">${stages.map(stage=>{const runId=positiveId(stage.runId);return `<div><span><b>${esc(stageRole(stage.role))}</b>${status(stage.status||'queued')}</span>${runId?`<button class="btn small" data-stage-task="${runId}">Open task #${runId}</button>`:'<small>Task not assigned yet</small>'}</div>`;}).join('')}</div>`:''}
      ${request.error?`<p class="runtime-capability-error"><b>${request.status==='needs_review'?'Review needed':'Build details'}</b> ${esc(request.error)}</p>`:''}
      ${compact?`<button class="runtime-capability-open" data-tool-request="${esc(id)}">View progress</button>`:''}
    </section>`;
  }
  function requestsSection(requests,runStatus,error='') {
    if(!requests.length&&!error&&runStatus!=='waiting_tool')return '';
    return `<section class="runtime-capability-section"><h3>${requests.length===1?'New tool request':'New tool requests'}</h3>${runStatus==='waiting_tool'?'<p class="muted">This task is waiting for a tool. Its progress and worker tasks are shown below.</p>':''}${error?`<p class="runtime-warning">Could not refresh tool requests: ${esc(error)}</p>`:''}${requests.length?requests.map(request=>requestCard(request)).join(''):'<p class="runtime-capability-empty">The tool request is being recorded. Details will appear here when available.</p>'}</section>`;
  }
  async function toolRequest(id) {
    const request=await api(`/api/tool-requests/${encodeURIComponent(id)}`);
    const el=modal(`<div class="modal-head"><h2>Tool request</h2><button class="icon-btn" data-close aria-label="Close">×</button></div><div data-tool-request-body aria-live="polite"></div><div class="modal-foot"><button class="btn" data-close>Close</button></div>`,{wide:true});
    let fingerprint='';
    function render(value){const next=JSON.stringify(value);if(next===fingerprint)return;fingerprint=next;
      replaceProgress(el.querySelector('[data-tool-request-body]'),requestCard(value,{detail:true})+`<div class="runtime-capability-meta">${value.domain?`<span>Area: ${esc(value.domain)}</span>`:''}${positiveId(value.origin_run_id)?`<button class="btn small" data-stage-task="${positiveId(value.origin_run_id)}">Original task #${positiveId(value.origin_run_id)}</button>`:''}${value.snapshot_id?`<details><summary>Recovery snapshot</summary><code>${esc(value.snapshot_id)}</code></details>`:''}</div>`);
    }
    render(request);
    async function refresh(){if(!document.body.contains(el))return;try{const current=await api(`/api/tool-requests/${encodeURIComponent(id)}`);if(!document.body.contains(el))return;el.querySelector('[data-request-refresh-error]')?.remove();render(current);if(terminalRequest(current))return;}catch(error){if(!document.body.contains(el))return;const target=el.querySelector('[data-tool-request-body]');let note=target.querySelector('[data-request-refresh-error]');if(!note){note=document.createElement('p');note.className='runtime-warning';note.dataset.requestRefreshError='';target.append(note);}note.textContent='Progress could not be refreshed: '+error.message;}if(document.body.contains(el))setTimeout(refresh,4000);}
    el.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button)return;try{if(button.hasAttribute('data-close'))return closeModal();if(button.dataset.stageTask)return await task(button.dataset.stageTask);}catch(error){toast(error.message);}});
    if(!terminalRequest(request))setTimeout(refresh,4000);
  }
  async function task(id) {
    const [run,detail]=await Promise.all([api(`/api/runs/${id}`),api(`/api/runs/${id}/events`)]);
    const el=modal(`<div class="modal-head"><h2>Task ${run.id}</h2><button class="icon-btn" data-close aria-label="Close">×</button></div>
      <div class="runtime-task-heading"><span data-run-status>${status(run.status)}</span><b>${esc(bot(run.bot_id)?.name||'Worker')}</b><span>${esc(run.actual_model||'Awaiting model selection')}</span></div>
      ${run.route_reason?`<p>${esc(run.route_reason)}</p>`:''}${run.fallback_reason?`<p class="runtime-warning">Fallback: ${esc(run.fallback_reason)}</p>`:''}
      <div data-run-error>${run.last_error?`<p class="runtime-warning">${esc(run.last_error)}</p>`:''}</div>
      <div data-run-budget>${budgetSection(run.budget)}</div>
      <div data-run-delegations>${delegationsSection(run.delegations)}</div>
      <div data-tool-requests aria-live="polite">${requestsSection(Array.isArray(run.toolRequests)?run.toolRequests:[],run.status)}</div>
      ${detail.events.length?`<div class="runtime-timeline">${detail.events.map(e=>`<div><time>${new Date(e.created_at*1000).toLocaleTimeString()}</time><b>${esc(e.type.replaceAll('.',' '))}</b><span>${esc(e.data.reason||e.data.error||e.data.model||e.data.name||'')}</span></div>`).join('')}</div>`:''}
      ${detail.tools.filter(t=>t.state==='uncertain').map(t=>`<section class="runtime-review"><h3>Action needs review: ${esc(t.name)}</h3><pre>${esc(t.args)}</pre><p>Inspect the action’s effects, then record what actually happened. This does not execute it again.</p><label class="field">Observed outcome<textarea data-outcome="${esc(t.id)}" rows="3"></textarea></label><button class="btn" data-resolve="${esc(t.id)}">Record observed outcome</button></section>`).join('')}
      <div data-run-result>${run.reply?`<h3>Result</h3><pre class="runtime-result">${esc(run.reply)}</pre>`:''}</div>
      <div class="modal-foot"><button class="btn left" data-open-task-chat>Open chat</button>${['paused','interrupted','error','needs_review'].includes(run.status)?'<button class="btn primary" data-resume>Resume checkpoint</button>':''}<button class="btn" data-close>Close</button></div>`,{wide:true});
    el.addEventListener('click',async e=>{const t=e.target.closest('button');if(!t)return;
      try{if(t.hasAttribute('data-close'))return closeModal();
        if(t.hasAttribute('data-open-task-chat')){closeModal();openThread(run.thread);}
        if(t.hasAttribute('data-resume')){await api(`/api/runs/${id}/resume`,{method:'POST'});closeModal();toast('Task queued from its checkpoint');}
        if(t.dataset.toolRequest)return await toolRequest(t.dataset.toolRequest);
        if(t.dataset.stageTask)return await task(t.dataset.stageTask);
        if(t.dataset.resolve){const field=[...el.querySelectorAll('[data-outcome]')].find(f=>f.dataset.outcome===t.dataset.resolve);await api(`/api/tool-calls/${encodeURIComponent(t.dataset.resolve)}/resolve`,{method:'POST',body:{observedResult:field.value}});return await task(id);}
      }catch(err){toast(err.message);}
    });
    let requestFingerprint='',latestRequests=Array.isArray(run.toolRequests)?run.toolRequests:[],latestStatus=run.status;
    async function refreshRequests(){if(!document.body.contains(el))return;try{
      const [current,response]=await Promise.all([api(`/api/runs/${id}`),api(`/api/tool-requests?runId=${encodeURIComponent(id)}`)]);
      if(!document.body.contains(el))return;const requests=requestArray(response),next=JSON.stringify([current.status,current.reply,current.last_error,current.budget,current.delegations,requests]);latestRequests=requests;latestStatus=current.status;
      if(next!==requestFingerprint){requestFingerprint=next;el.querySelector('[data-run-status]').innerHTML=status(current.status);replaceProgress(el.querySelector('[data-tool-requests]'),requestsSection(requests,current.status));el.querySelector('[data-run-budget]').innerHTML=budgetSection(current.budget);replaceProgress(el.querySelector('[data-run-delegations]'),delegationsSection(current.delegations));el.querySelector('[data-run-error]').innerHTML=current.last_error?`<p class="runtime-warning">${esc(current.last_error)}</p>`:'';el.querySelector('[data-run-result]').innerHTML=current.reply?`<h3>Result</h3><pre class="runtime-result">${esc(current.reply)}</pre>`:'';}
      if(!['queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input','waiting_tool'].includes(current.status)&&requests.every(terminalRequest))return;
    }catch(error){if(document.body.contains(el)&&latestStatus==='waiting_tool')replaceProgress(el.querySelector('[data-tool-requests]'),requestsSection(latestRequests,latestStatus,error.message));}
      if(document.body.contains(el))setTimeout(refreshRequests,4000);
    }
    refreshRequests();
  }
  function budgetSection(budget){return budget?`<p class="runtime-budget" aria-label="Tool budget"><span>Actions <b>${fmt(budget.actionsUsed)} / ${fmt(budget.actionLimit)}</b></span><span>Tool attempts <b>${fmt(budget.attemptsUsed)} / ${fmt(budget.attemptLimit)}</b></span>${budget.continuation?`<span>Continuation ${fmt(budget.continuation)}</span>`:''}</p>`:'';}
  function delegationsSection(children){const rows=Array.isArray(children)?children:[];return `<section class="runtime-delegations"><h3>Delegated work</h3>${rows.length?rows.map(child=>`<div><span><b>${esc(child.worker_name||bot(child.bot_id)?.name||'Worker')}</b>${status(child.status)}</span><button class="btn small" data-stage-task="${positiveId(child.id)}">Open task #${positiveId(child.id)}</button></div>`).join(''):'<p class="muted">No specialist tasks have been assigned in this run.</p>'}</section>`;}
  async function group(id) {
    const r=await api('/api/browser-groups'),g=r.groups.find(g=>g.owner===Number(id));
    const el=modal(`<div class="modal-head"><h2>${esc(bot(id)?.name||'Worker')}’s browser group</h2><button class="icon-btn" data-close aria-label="Close">×</button></div>
      <p class="muted">Tabs, cookies and sign-ins are separate from every other worker. Actions target the page directly.</p>
      ${g?.tabs.length?g.tabs.map(t=>`<details class="runtime-tab"><summary>${esc(t.url)}</summary><img loading="lazy" src="/api/browser/${id}/${encodeURIComponent(t.id)}/screenshot" alt="Preview of ${esc(t.url)}"></details>`).join(''):'<p>No open tabs. The group opens when this worker uses its browser tool.</p>'}`,{wide:true});
    el.addEventListener('click',e=>{if(e.target.closest('[data-close]'))closeModal();});
  }
  async function overview() {
    const el=modal('<div class="modal-head"><h2>Your Nimbus team</h2><button class="icon-btn" data-close aria-label="Close">×</button></div><div data-runtime-body aria-live="polite">Reading worker and model state…</div>',{wide:true});
    async function load() {
      if(!document.body.contains(el))return;
      try{
        const [r,tasks,requestResponse]=await Promise.all([api('/api/runtime'),api('/api/tasks'),api('/api/tool-requests').catch(error=>({requests:[],error:error.message}))]);
        const requests=requestArray(requestResponse),activeRequests=requests.filter(request=>!terminalRequest(request)&&!requestNeedsAttention(request)),attentionRequests=requests.filter(requestNeedsAttention);
        const recentRequests=[...attentionRequests,...activeRequests,...requests.filter(terminalRequest)].slice(0,6);
        const loaded=r.local.models.filter(m=>m.loaded),gpu=r.hardware.gpu?.[0];
        replaceProgress(el.querySelector('[data-runtime-body]'),`<div class="runtime-resources">
          <section><h3>Shared local model</h3><b>${esc(loaded.map(m=>m.id).join(', ')||'Loads on demand')}</b><p class="muted">${r.queues.local.active} inference active · ${r.queues.local.queued} waiting · ${r.configuration.resourceCeiling}% resource ceiling</p>
            <div class="runtime-meter"><span>GPU memory</span><b>${gpu?Math.round(gpu.percent)+'%':'Unknown'}</b></div><progress max="100" value="${gpu?.percent||0}" aria-label="GPU memory used"></progress>
            <div class="runtime-meter"><span>System memory</span><b>${Math.round(r.hardware.ram.percent)}%</b></div><progress max="100" value="${r.hardware.ram.percent}" aria-label="System memory used"></progress>
            ${r.local.error?`<p class="runtime-warning">${esc(r.local.error)}</p>`:''}</section>
          <section><h3>OpenAI subscription</h3><b>${r.cloud.subscription?'Connected through Codex':'Sign-in required'}</b><p class="muted">${r.queues.cloud.active} tasks active · ${r.queues.cloud.queued} waiting</p><div class="runtime-models">${r.cloud.models.filter(m=>/luna|terra|sol|astra/.test(m.id)).map(m=>`<span>${esc(m.id)}</span>`).join('')}</div>
            <p class="muted">The local model selects the task route. No automatic paid API billing.</p>${r.cloud.error?`<p class="runtime-warning">${esc(r.cloud.error)}</p>`:''}</section></div>
          <section class="runtime-capability-overview"><div class="runtime-capability-overview-heading"><h3>New tools</h3>${requests.length?`<span>${activeRequests.length} in progress${attentionRequests.length?`, ${attentionRequests.length} need attention`:''}</span>`:''}</div>${requestResponse.error?`<p class="runtime-warning">Could not load tool requests: ${esc(requestResponse.error)}</p>`:recentRequests.length?`<div class="runtime-capability-list">${recentRequests.map(request=>requestCard(request,{compact:true})).join('')}</div>`:'<p class="runtime-capability-empty">No tool builds are waiting. Requests appear here when a worker needs a new capability.</p>'}</section>
          <h3>Workers</h3><div class="runtime-workers">${S.data.bots.map(b=>{const last=tasks.find(t=>t.bot_id===b.id),g=r.browserGroups.find(g=>g.owner===b.id);return`<div class="runtime-worker">${avatar(b,38)}<div><b>${esc(b.name)}</b><p>${esc(b.role)}</p>${b.parent_bot_id?`<small>Subagent of ${esc(bot(b.parent_bot_id)?.name||'#'+b.parent_bot_id)}</small>`:''}<span class="muted">${esc(last?.actual_model||'No task yet')} · ${esc(b.status.label)}</span><small class="runtime-role-model">${b.model&&b.model!=='auto'?`Override: ${esc(b.model)}`:`Automatic · prefers ${esc(b.default_model==='local'?'shared local':b.default_model||'task-based selection')}`}</small></div><button class="btn small" data-group="${b.id}">${g?.tabs.length||0} browser tabs</button><button class="btn small" data-chat="bot:${b.id}">Chat</button></div>`;}).join('')||'<p>Create a worker to begin.</p>'}</div>
          <h3>Task timeline</h3><div class="runtime-task-list">${tasks.slice(0,40).map(t=>`<button class="runtime-task" data-task="${t.id}"><span class="runtime-task-id">#${t.id}${t.parent_run?`<small>from #${t.parent_run}</small>`:''}</span><span><b>${esc(bot(t.bot_id)?.name||'Worker')}</b><small>${esc(t.actual_model||t.route_reason||'Awaiting route')}</small></span>${status(t.status)}<span class="muted">${fmt(t.input_tokens+t.output_tokens)} tokens</span></button>`).join('')||'<p>No tasks yet. Assign one in a worker chat.</p>'}</div>
          <p class="muted runtime-boundary">Lumos integration is disconnected.</p>`);
      }catch(err){el.querySelector('[data-runtime-body]').textContent=err.message;}
      if(document.body.contains(el))setTimeout(load,5000);
    }
    el.addEventListener('click',async e=>{const t=e.target.closest('button');if(!t)return;try{if(t.hasAttribute('data-close'))return closeModal();if(t.dataset.toolRequest)return await toolRequest(t.dataset.toolRequest);if(t.dataset.stageTask)return await task(t.dataset.stageTask);if(t.dataset.task)return await task(t.dataset.task);if(t.dataset.group)return await group(t.dataset.group);if(t.dataset.chat){closeModal();openThread(t.dataset.chat);}}catch(error){toast(error.message);}});
    await load();
  }
  async function settings() {
    const [c,s]=await Promise.all([api('/api/runtime/config'),api('/api/settings')]);
    const el=modal(`<div class="modal-head"><h2>Nimbus settings</h2><button class="icon-btn" data-close aria-label="Close">×</button></div>
      <h3>Shared local inference</h3><label class="field">Endpoint<input id="rt-url" value="${esc(c.local.baseUrl)}"></label><label class="field">Default local model<input id="rt-model" value="${esc(c.local.model)}"></label>
      <div class="two"><label class="field">Maximum simultaneous workers<input id="rt-workers" type="number" min="1" max="32" value="${c.workers.maxConcurrent}"></label><label class="field">Maximum OpenAI tasks<input id="rt-cloud" type="number" min="1" max="16" value="${c.cloud.maxConcurrent}"></label></div>
      <p class="muted">Local inference is shared and serialized. Already loaded approved models are reused. Credential sources stay in the local configuration file.</p>
      <h3>OpenAI subscription</h3><button class="btn" data-login>Sign in with ChatGPT</button><p class="muted">Nimbus uses Codex’s native sign-in. You can also run <code>codex login</code> on this Windows account.</p>
      <h3>Browser groups</h3><label class="toggle-row"><span>Run worker browsers in the background</span><input id="rt-headless" type="checkbox" ${c.browser.headless?'checked':''}></label><p class="muted">Changing browser mode takes effect after a Nimbus restart. Group cookies and sign-ins are saved for this Windows account.</p>
      <h3>Backups</h3><label class="field">Additional local or UNC backup folder<input id="rt-backup-target" value="${esc(s.backup_target||'')}" placeholder="Optional"></label><button class="btn" data-backup>Back up now</button><p class="muted" data-backup-status>Encrypted backups include tasks, artifacts, worker memory, and configuration. Keep the recovery key separately for migration.</p>
      <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Save changes</button></div>`,{wide:true});
    el.addEventListener('click',async e=>{const t=e.target.closest('button');if(!t)return;try{
      if(t.hasAttribute('data-close'))return closeModal();
      if(t.hasAttribute('data-login')){const r=await api('/api/openai/login',{method:'POST'});if(r.authUrl)window.open(r.authUrl,'_blank','noopener');return;}
      if(t.hasAttribute('data-backup')){t.disabled=true;const r=await api('/api/backup',{method:'POST'});el.querySelector('[data-backup-status]').textContent=r.ok?'Backup saved: '+r.file:'Backup failed: '+r.error;t.disabled=false;return;}
      if(t.hasAttribute('data-save')){
        await api('/api/runtime/config',{method:'PUT',body:{local:{baseUrl:el.querySelector('#rt-url').value,model:el.querySelector('#rt-model').value},workers:{maxConcurrent:Number(el.querySelector('#rt-workers').value)},cloud:{maxConcurrent:Number(el.querySelector('#rt-cloud').value)},browser:{headless:el.querySelector('#rt-headless').checked}}});
        await api('/api/settings',{method:'PUT',body:{backup_target:el.querySelector('#rt-backup-target').value}});closeModal();await refreshState();toast('Nimbus settings saved');
      }
    }catch(err){toast(err.message);}});
  }
  return{overview,task,group,settings,toolRequest};
}
