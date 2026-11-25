// Model catalog order is presentation order, not a version guarantee.
export function resolveCloudModel(tier, status, c) {
  const pinned = c.cloud.models[tier];
  if (pinned && pinned !== 'auto') return pinned;
  const pattern = new RegExp(`^gpt-(\\d+(?:\\.\\d+)*)-${tier}(?:-(latest|\\d{4}-\\d{2}-\\d{2}))?$`, 'i');
  const candidates = status.models.flatMap(entry => {
    const model = entry.model || entry.id, match = pattern.exec(model);
    return match ? [{model, version: match[1].split('.').map(Number), suffix: match[2] || ''}] : [];
  });
  candidates.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const difference = (b.version[i] || 0) - (a.version[i] || 0);
      if (difference) return difference;
    }
    // Prefer the rolling family alias to a fixed dated snapshot of that version.
    return Number(!!a.suffix) - Number(!!b.suffix) || b.suffix.localeCompare(a.suffix) || a.model.localeCompare(b.model);
  });
  if (!candidates.length) throw new Error(`The signed-in account advertises no ${tier} model`);
  return candidates[0].model;
}
