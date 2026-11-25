const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const labels = {queued:'Queued',designing:'Designing',building:'Building',testing:'Testing',reviewing:'Reviewing',validating:'Validating',deploying:'Applying update',ready:'Ready',blocked:'Needs attention',cancelled:'Cancelled'};

export function capabilityRequest(message) {
  if (message?.kind !== 'capability' || message.author === 'user') return null;
  try {
    const value = JSON.parse(message.body);
    return value && typeof value.requestId === 'string' && value.requestId.trim() ? value : null;
  } catch { return null; }
}
export function groupToolRequestMessages(messages) {
  const groups = new Map(), visible = [];
  for (const message of messages) {
    const request = capabilityRequest(message);
    if (!request) { visible.push(message); continue; }
    const key = JSON.stringify([message.thread || '', request.requestId]);
    let group = groups.get(key);
    if (!group) { group = {...message, capabilityUpdates:[]}; groups.set(key, group); visible.push(group); }
    group.capabilityUpdates.push(message);
  }
  return visible;
}
export function renderToolRequestChain(message, {open = false, formatTime = value => new Date(value * 1000).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})} = {}) {
  const updates = (message.capabilityUpdates || [message]).map(item => ({message:item, request:capabilityRequest(item)})).filter(item => item.request);
  if (!updates.length) return `<div class="note" data-mid="${escapeHTML(message.id)}">Tool request update unavailable.</div>`;
  const ordered = [...updates].sort((a,b) => (Number(a.request.version) || 0) - (Number(b.request.version) || 0) || Number(a.message.id) - Number(b.message.id));
  const latest = ordered.at(-1), current = latest.request, history = ordered.slice(0,-1);
  const status = (value, actionable = false) => {
    const label = escapeHTML(labels[value] || value || 'Queued'), className = `task-status ${escapeHTML(value)}`;
    return actionable && value === 'blocked'
      ? `<button type="button" class="${className} runtime-attention-link" data-tool-development="${escapeHTML(current.requestId)}" aria-label="Needs attention: open ${escapeHTML(current.title || 'tool request')}">${label}</button>`
      : `<span class="${className}">${label}</span>`;
  };
  const time = item => Number.isFinite(item.created_at) ? `<time datetime="${new Date(item.created_at * 1000).toISOString()}">${escapeHTML(formatTime(item.created_at))}</time>` : '';
  return `<div class="msg bot" data-mid="${escapeHTML(message.id)}"><section class="runtime-capability-card compact" data-tool-request-chain="${escapeHTML(current.requestId)}">
    <div class="runtime-capability-heading" data-capability-mid="${escapeHTML(latest.message.id)}"><b>${escapeHTML(current.title || 'Tool development')}</b>${status(current.status, true)}</div>
    <p class="runtime-capability-message" role="status">${escapeHTML(current.message || '')}</p>
    <div class="runtime-capability-meta"><code>${escapeHTML(current.toolName || '')}</code><button class="btn small" data-tool-development="${escapeHTML(current.requestId)}">View progress</button>${time(latest.message)}</div>
    ${history.length ? `<details class="runtime-capability-history" data-capability-history="${escapeHTML(current.requestId)}" ${open ? 'open' : ''}><summary>Earlier updates <span>${history.length}</span></summary><ol>${history.map(item => `<li data-capability-mid="${escapeHTML(item.message.id)}" data-capability-update><div>${status(item.request.status)}${time(item.message)}</div><p>${escapeHTML(item.request.message || '')}</p></li>`).join('')}</ol></details>` : ''}
  </section></div>`;
}
