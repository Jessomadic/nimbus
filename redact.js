// Masks secrets (API keys, tokens, passwords) before chat text is saved or shown.
// It errs toward hiding: a false positive costs a [REDACTED] in the history, a miss leaks a credential.
const MASK = '[REDACTED]';
const KNOWN = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bGOCSPX-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{32,}/g,
  /(?!) /g // PEM handled linearly below
];
// NAME=value / "name": "value" where the name says it's a secret.
const ASSIGN = /((?:password|passwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key)[A-Za-z0-9_]*\\?["']?\s*[:=]\s*\\?["']?)([^\s"'\\&,;]{6,})/gi;
const PVE = /(PVEAPIToken=[^=\s]+=)[0-9a-f-]{36}/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CRED_WORDS = /\b(creds?|credentials?|secret|token|password|api key)\b/i;

export function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let s = '', cursor = 0;
  // Linear fail-closed scan. Missing END consumes the remaining capture prefix.
  while (cursor < text.length) {
    const begin = text.indexOf('-----BEGIN ', cursor);
    if (begin < 0) { s += text.slice(cursor); break; }
    const headerEnd = text.indexOf('-----', begin + 11);
    const header = headerEnd < 0 ? '' : text.slice(begin + 11, Math.min(headerEnd, begin + 139));
    if (headerEnd < 0 || headerEnd > begin + 139 || !/^[A-Z ]*PRIVATE KEY$/.test(header)) {
      s += text.slice(cursor, begin + 11); cursor = begin + 11; continue;
    }
    s += text.slice(cursor, begin) + MASK;
    const marker = '-----END ' + header + '-----';
    const end = text.indexOf(marker, headerEnd + 5);
    cursor = end < 0 ? text.length : end + marker.length;
  }
  for (const re of KNOWN) s = s.replace(re, MASK);
  s = s.replace(PVE, `$1${MASK}`);
  s = s.replace(ASSIGN, (all, name, val) => (val === MASK || /^\$|^\[/.test(val) ? all : name + MASK));
  // Bare UUIDs are usually harmless IDs, but next to words like "token" or "creds" they are likely a secret.
  if (CRED_WORDS.test(s)) s = s.replace(UUID, MASK);
  return s;
}

// Redact values before encoding JSON. Applying a text regex to encoded JSON
// can replace a numeric token-count plus its closing brace and corrupt state.
export function redactValue(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,
    typeof item === 'string' && /^(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)$/i.test(key)
      ? '[REDACTED]' : redactValue(item)]));
  return value;
}
export function encodeRedacted(value) { return JSON.stringify(redactValue(value)); }
