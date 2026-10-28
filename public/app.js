// Nimbus web app. Plain JS, no build step.
import { createRuntimeUI } from './runtime.js';
import {installDownloads} from './downloads.js';
installDownloads({report:message=>toast(message)});
import {hierarchyRows} from './team-tree.js';
import {DISPLAY_GROUPS,defaultDisplayGroup} from './agent-groups.js';
import {SIDEBAR_GROUPS,normalizeSidebarLayout,sidebarGroupAncestors} from './sidebar-layout.js';
import {installSidebarDrag} from './sidebar-drag.js';
import { attachAutocorrect } from './autocorrect.js';
import { THEMES, resolveTheme, applyThemeVars } from './themes.js';
import { startRecording, stopRecording, cancelRecording, isRecording, browserDictation } from './dictation.js';
import { passkeyRequest, performPasskey, passkeyError, canonicalPasskeyOrigin } from './passkeys.js';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
const BOT_COLORS = ['#f4f6ff', '#c7e3ff', '#d9d1ff', '#ffd3e0', '#ffe6a8', '#c9f2d8', '#ffcfb0', '#8fb8ff', '#b39dff', '#ff9fb5', '#7fd6c2', '#9aa3ad',
  '#ff6b6b', '#ff9f43', '#feca57', '#a3e635', '#2ed573', '#1dd1a1', '#48dbfb', '#54a0ff', '#5f27cd', '#c56cf0', '#ff7eb3', '#576574', '#f5e6d3', '#8d6e63', '#2d3436', '#ffffff'];
const svg = (d, w = 18) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  send: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 16),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  grid: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  book: svg('<path d="M5 4.5h10a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h10"/>'),
  plug: svg('<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.4-.9a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>'),
  compose: svg('<path d="M12 20h8M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/>'),
  dots: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', 14),
  check: svg('<path d="m5 12 5 5 9-10"/>', 14),
  chevron: svg('<path d="m9 6 6 6-6 6"/>', 14),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  clip: svg('<path d="m20 11.5-8.3 8.3a5 5 0 0 1-7-7l8.8-8.8a3.3 3.3 0 0 1 4.7 4.7l-8.8 8.8a1.7 1.7 0 0 1-2.4-2.4l8.1-8.1"/>'),
  monitor: svg('<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>')
};

const S = { data: null, current: null, messages: [], loadingThread: false, market: null };
let runtimeUI;

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) { location.href = '/login'; throw new Error('Logged out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  document.querySelectorAll('.toast').forEach((o) => o.remove()); // newest wins, no pile-up
  document.body.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, 2600);
}

// A light tap on phones (Android browsers and the Nimbus app); ignored elsewhere.
const buzz = (ms = 8) => { try { if (matchMedia('(pointer: coarse)').matches) navigator.vibrate?.(ms); } catch {} };

// ---------- theme ----------
function getPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('nimbus.appearance')) || {}; } catch {}
  // Older settings had { mode: dark|light|system, accent } and no theme.
  if (!p.theme) { p.theme = p.mode || 'dark'; if (p.accent === '#3b82f6') delete p.accent; } // old default accent: use the theme's
  return p;
}
function applyTheme() {
  const p = getPrefs();
  const theme = resolveTheme(p, matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name=theme-color]').content = applyThemeVars(document.documentElement, theme, p.accent);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- helpers ----------
const bot = (id) => S.data?.bots.find((b) => b.id === Number(id));
const room = (id) => S.data?.rooms.find((r) => r.id === Number(id));
const threadKey = () => S.current ? `${S.current.type}:${S.current.id}` : null;
function describeTool(tool,input={}){
  tool=String(tool||'Tool');input=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
  if(['shell','exec_command','Bash'].includes(tool))return 'Run: '+String(input.command||'').slice(0,80);
  const pretty=tool.replace(/^mcp__/,'').replace(/__/g,' › ').replace(/_/g,' '),hint=input.to||input.subject||input.title||input.url||input.path||input.file_path||'';
  return pretty+(hint?' — '+String(hint).slice(0,60):'');
}
// A bot's look is stored in `shape` as "hat/glasses/body/face/extra". Older bots only have
// "hat/glasses"; the missing parts fall back to the original cloud with a smile.
const HATS = ['none', 'cap', 'beanie', 'tophat', 'crown', 'party', 'headphones', 'halo', 'wizard', 'chef', 'cowboy', 'bow', 'flower', 'horns', 'antenna', 'santa', 'sprout'];
const GLASSES = ['none', 'shades', 'specs', 'monocle', 'visor', '3d', 'round', 'heart', 'star', 'eyepatch', 'goggles'];
const BODIES = ['cloud', 'blob', 'ghost', 'box', 'cat'];
const FACES = ['smile', 'happy', 'wink', 'surprised', 'sleepy', 'cat', 'tongue', 'mustache', 'grumpy'];
const EXTRAS = ['none', 'bowtie', 'scarf', 'tie', 'sparkles', 'hearts', 'badge'];
const LOOK_PARTS = [['body', BODIES, 'Body'], ['face', FACES, 'Face'], ['hat', HATS, 'Hat'], ['glasses', GLASSES, 'Glasses'], ['extra', EXTRAS, 'Extra']];
const px = (x, y, w, h, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`;
function outfit(b) {
  const [hat, glasses, body, face, extra] = String(b?.shape || '').split('/');
  const pick = (v, list) => (list.includes(v) ? v : list[0]);
  return { hat: pick(hat, HATS), glasses: pick(glasses, GLASSES), body: pick(body, BODIES), face: pick(face, FACES), extra: pick(extra, EXTRAS) };
}
const lookShape = (l) => [l.hat, l.glasses, l.body, l.face, l.extra].join('/');

// Body outlines as [row, firstCol, lastCol] spans on the 14x14 grid; eyes and cheeks sit on rows 6-8 for every body.
const BODY_ROWS = {
  cloud: { rows: [[2, 4, 6], [3, 3, 7], [3, 9, 10], [4, 2, 11], [5, 1, 12], [6, 1, 12], [7, 1, 12], [8, 1, 12], [9, 2, 5], [9, 7, 11]], feet: true },
  blob: { rows: [[2, 5, 8], [3, 3, 10], [4, 2, 11], [5, 1, 12], [6, 1, 12], [7, 1, 12], [8, 1, 12], [9, 2, 11]], feet: true },
  ghost: { rows: [[2, 4, 9], [3, 3, 10], [4, 2, 11], [5, 2, 11], [6, 2, 11], [7, 2, 11], [8, 2, 11], [9, 2, 11], [10, 2, 3], [10, 5, 6], [10, 8, 9], [10, 11, 11]], feet: false },
  box: { rows: [[3, 2, 11], [4, 1, 12], [5, 1, 12], [6, 1, 12], [7, 1, 12], [8, 1, 12], [9, 2, 11]], feet: true },
  cat: { rows: [[1, 2, 3], [1, 10, 11], [2, 2, 4], [2, 9, 11], [3, 2, 11], [4, 1, 12], [5, 1, 12], [6, 1, 12], [7, 1, 12], [8, 1, 12], [9, 2, 5], [9, 7, 11]], feet: true }
};

function critter(color, look = {}, legacyGlasses) {
  if (typeof look === 'string') look = { hat: look, glasses: legacyGlasses }; // old (color, hat, glasses) calls
  const { hat = 'none', glasses = 'none', body = 'cloud', face = 'smile', extra = 'none' } = look;
  const c = esc(color || '#f4f6ff'), ink = '#16204a', shade = ' opacity=".12"';
  const B = BODY_ROWS[body] || BODY_ROWS.cloud;
  const feet = B.feet ? [[4, 10, 2], [8, 10, 2]] : [];
  const bottom = Math.max(...B.rows.map((r) => r[0]));
  let s = B.rows.map(([y, a, z]) => px(a - 0.5, y - 0.5, z - a + 2, 2, ink)).join('')
    + feet.map(([x, y, w]) => px(x - 0.5, y - 0.2, w + 1, 1.7, ink)).join('')
    + B.rows.map(([y, a, z]) => px(a, y, z - a + 1, 1, c)).join('')
    + feet.map(([x, y, w]) => px(x, y, w, 1, c)).join('')
    + B.rows.filter(([y]) => y === bottom).map(([y, a, z]) => px(a, y, z - a + 1, 1, ink, shade)).join('')
    + px(4.3, (B.rows[0][0]) + 0.3, 1.2, 0.5, '#fff', ' opacity=".8"');
  if (body === 'box') s += px(6.5, 1, 1, 2, ink) + px(6.1, 0.4, 1.8, 1, '#f5c542');
  if (body === 'cat') s += px(2.6, 1.6, 0.8, 0.8, '#f59bb0') + px(10.6, 1.6, 0.8, 0.8, '#f59bb0');

  // Face: eyes, cheeks and mouth.
  const eye = (x) => px(x, 6, 1.3, 1.5, ink) + px(x + 0.4, 6.2, 0.45, 0.45, '#fff');
  const closed = (x) => px(x - 0.1, 6.7, 1.5, 0.45, ink);
  const arc = (x) => px(x, 6.4, 0.45, 0.45, ink) + px(x + 0.4, 6, 0.6, 0.45, ink) + px(x + 0.9, 6.4, 0.45, 0.45, ink);
  const cheeks = px(2.4, 7.7, 1.1, 0.6, '#f59bb0') + px(10.5, 7.7, 1.1, 0.6, '#f59bb0');
  const smile = px(6.1, 7.6, 0.4, 0.4, ink) + px(6.5, 8, 1, 0.4, ink) + px(7.5, 7.6, 0.4, 0.4, ink);
  s += cheeks + {
    smile: eye(3.8) + eye(8.9) + smile,
    happy: arc(3.8) + arc(8.9) + px(6.1, 7.6, 1.8, 0.5, ink) + px(6.4, 8.1, 1.2, 0.5, '#e2475f'),
    wink: eye(3.8) + arc(8.9) + smile,
    surprised: eye(3.8) + eye(8.9) + px(6.4, 7.6, 1.2, 1.2, ink),
    sleepy: closed(3.8) + closed(8.9) + px(6.5, 8, 1, 0.4, ink) + px(11.6, 3.2, 0.9, 0.3, ink) + px(12.2, 2.9, 0.3, 0.3, ink) + px(11.6, 2.6, 0.9, 0.3, ink),
    cat: eye(3.8) + eye(8.9) + px(5.9, 7.7, 0.4, 0.4, ink) + px(6.3, 8.1, 0.6, 0.4, ink) + px(6.8, 7.7, 0.4, 0.4, ink) + px(7.1, 8.1, 0.6, 0.4, ink) + px(7.6, 7.7, 0.4, 0.4, ink),
    tongue: eye(3.8) + eye(8.9) + smile + px(6.6, 8.3, 0.8, 0.7, '#e2475f'),
    mustache: eye(3.8) + eye(8.9) + px(5.3, 7.6, 3.4, 0.6, '#5a3a22') + px(4.9, 7.9, 0.6, 0.5, '#5a3a22') + px(8.5, 7.9, 0.6, 0.5, '#5a3a22'),
    grumpy: eye(3.8) + eye(8.9) + px(3.6, 5.4, 1.5, 0.35, ink) + px(8.9, 5.4, 1.5, 0.35, ink) + px(6.1, 8, 0.4, 0.4, ink) + px(6.5, 7.7, 1, 0.4, ink) + px(7.5, 8, 0.4, 0.4, ink)
  }[face];

  const E = 6, L = 3.3, R = 8.4;
  const heart = (x, y, f) => px(x, y, 0.8, 0.8, f) + px(x + 1.2, y, 0.8, 0.8, f) + px(x - 0.2, y + 0.5, 2.4, 0.8, f) + px(x + 0.3, y + 1.2, 1.4, 0.6, f) + px(x + 0.7, y + 1.7, 0.6, 0.4, f);
  const star = (x, y, f, k = 1) => px(x + 0.8 * k, y, 0.6 * k, 2.2 * k, f) + px(x, y + 0.8 * k, 2.2 * k, 0.6 * k, f) + px(x + 0.4 * k, y + 0.4 * k, 1.4 * k, 1.4 * k, f);
  s += {
    none: '',
    shades: px(L, E - 0.2, 2.4, 1.8, '#111') + px(R, E - 0.2, 2.4, 1.8, '#111') + px(L + 2.4, E + 0.3, R - L - 2.4, 0.45, '#111') + px(L + 0.3, E + 0.1, 0.7, 0.35, '#fff', ' opacity=".55"') + px(R + 0.3, E + 0.1, 0.7, 0.35, '#fff', ' opacity=".55"'),
    specs: `<g fill="rgba(255,255,255,.25)" stroke="${ink}" stroke-width=".4">${px(L, E - 0.3, 2.4, 2, '')}${px(R, E - 0.3, 2.4, 2, '')}</g>` + px(L + 2.4, E + 0.4, R - L - 2.4, 0.4, ink),
    monocle: `<rect x="${R - 0.1}" y="${E - 0.4}" width="2.6" height="2.2" rx="1" fill="rgba(255,255,255,.25)" stroke="#f5c542" stroke-width=".4"/>` + px(R + 2.2, E + 1.8, 0.4, 2, '#f5c542'),
    visor: px(1.5, E - 0.4, 11, 2.1, '#48d6f0') + px(1.5, E - 0.4, 11, 0.55, '#b8f3ff') + px(3.8, E + 0.1, 1.3, 1.1, '#0b3a44', ' opacity=".55"') + px(8.9, E + 0.1, 1.3, 1.1, '#0b3a44', ' opacity=".55"'),
    '3d': `<g stroke="#f4f4f4" stroke-width=".4">${px(L, E - 0.3, 2.4, 2, '#e2475f')}${px(R, E - 0.3, 2.4, 2, '#3fb6e8')}</g>` + px(L + 2.4, E + 0.4, R - L - 2.4, 0.4, '#f4f4f4'),
    round: `<g fill="rgba(255,255,255,.2)" stroke="#b07a3b" stroke-width=".45"><circle cx="${L + 1.2}" cy="${E + 0.7}" r="1.35"/><circle cx="${R + 1.2}" cy="${E + 0.7}" r="1.35"/></g>` + px(L + 2.5, E + 0.5, R - L - 2.6, 0.35, '#b07a3b'),
    heart: heart(L + 0.2, E - 0.3, '#e84fa0') + heart(R + 0.2, E - 0.3, '#e84fa0') + px(L + 2.4, E + 0.3, R - L - 2.4, 0.4, '#e84fa0'),
    star: star(L + 0.1, E - 0.5, '#f5c542') + star(R + 0.1, E - 0.5, '#f5c542') + px(L + 2.3, E + 0.4, R - L - 2.2, 0.4, '#f5c542'),
    eyepatch: px(R - 0.1, E - 0.4, 2.6, 2.2, '#111') + px(1, E - 1.6, R - 1, 0.4, '#111') + px(R + 2.5, E - 0.4, 2, 0.4, '#111'),
    goggles: px(1.2, E + 0.2, 11.6, 0.6, '#5a3a22') + `<g stroke="#8a8f98" stroke-width=".5" fill="#9be7c4" fill-opacity=".55">${px(L - 0.2, E - 0.5, 2.8, 2.4, '')}${px(R - 0.2, E - 0.5, 2.8, 2.4, '')}</g>`
  }[glasses] || '';

  const X = 5.5, T = (B.rows[0][0] === 1 ? 2 : B.rows[0][0]) + 1; // hat centre and the top of the body
  s += {
    none: '',
    cap: px(X - 2.5, T - 1.6, 5, 1.9, '#2f6fed') + px(X + 1.5, T - 0.2, 4, 0.9, '#2356c4') + px(X - 0.5, T - 2, 1, 0.5, '#2356c4'),
    beanie: px(X - 2.5, T - 2.2, 5, 1.8, '#1f9d6b') + px(X - 3, T - 0.6, 6, 1, '#167a52') + px(X - 0.5, T - 3.1, 1, 1, '#f4f4f4'),
    tophat: px(X - 1.8, T - 4, 3.6, 3.4, '#1b1b1b') + px(X - 1.8, T - 1.4, 3.6, 0.6, '#e2475f') + px(X - 2.9, T - 0.6, 5.8, 0.9, '#1b1b1b'),
    crown: px(X - 2.5, T - 1, 5, 1.1, '#f5c542') + px(X - 2.5, T - 2.1, 1, 1.1, '#f5c542') + px(X - 0.5, T - 2.5, 1, 1.5, '#f5c542') + px(X + 1.5, T - 2.1, 1, 1.1, '#f5c542') + px(X - 0.5, T - 0.8, 1, 0.7, '#e2475f'),
    party: px(X - 2, T - 0.8, 4, 1, '#e84fa0') + px(X - 1.5, T - 1.8, 3, 1, '#f5c542') + px(X - 1, T - 2.8, 2, 1, '#e84fa0') + px(X - 0.5, T - 3.8, 1, 1, '#3fb6e8'),
    headphones: px(2.2, T - 0.3, 9.6, 0.7, '#262626') + px(1.6, T + 0.2, 0.8, 2.5, '#262626') + px(11.6, T + 0.2, 0.8, 2.5, '#262626') + px(0.2, 5, 1.8, 2.6, '#262626') + px(12, 5, 1.8, 2.6, '#262626'),
    halo: `<ellipse cx="${X + 3}" cy="${T - 1.6}" rx="2.8" ry=".8" fill="none" stroke="#8b93f5" stroke-width=".55"/>`,
    wizard: px(X - 3, T - 0.6, 6.5, 0.9, '#5b3fc4') + px(X - 2, T - 1.6, 4.5, 1, '#6b4fe0') + px(X - 1.2, T - 2.6, 3, 1, '#6b4fe0') + px(X - 0.4, T - 3.6, 1.8, 1, '#6b4fe0') + px(X + 0.6, T - 4.3, 1.2, 0.8, '#6b4fe0') + px(X - 1, T - 1.4, 0.6, 0.6, '#f5c542') + px(X + 1.2, T - 2.4, 0.5, 0.5, '#f5c542'),
    chef: px(X - 2.2, T - 1.2, 4.4, 1.4, '#f4f4f4') + px(X - 2.6, T - 3, 1.9, 1.9, '#f4f4f4') + px(X - 1, T - 3.5, 2, 2.4, '#f4f4f4') + px(X + 0.7, T - 3, 1.9, 1.9, '#f4f4f4') + px(X - 2.2, T - 0.2, 4.4, 0.4, '#c9ccd4'),
    cowboy: px(X - 4, T - 0.4, 8, 0.9, '#8a5a2b') + px(X - 4.4, T - 0.9, 1, 0.7, '#8a5a2b') + px(X + 3.4, T - 0.9, 1, 0.7, '#8a5a2b') + px(X - 2, T - 2.6, 4, 2.3, '#a86d35') + px(X - 2, T - 1, 4, 0.5, '#5a3a22'),
    bow: px(X + 1.5, T - 1.2, 1.6, 1.8, '#e84fa0') + px(X + 4, T - 1.2, 1.6, 1.8, '#e84fa0') + px(X + 3, T - 0.8, 1.1, 1.1, '#c23a84'),
    flower: px(X + 2.6, T - 2.4, 1.1, 1.1, '#ff9fb5') + px(X + 1.5, T - 1.3, 1.1, 1.1, '#ff9fb5') + px(X + 3.7, T - 1.3, 1.1, 1.1, '#ff9fb5') + px(X + 2.6, T - 0.2, 1.1, 1.1, '#ff9fb5') + px(X + 2.6, T - 1.3, 1.1, 1.1, '#f5c542'),
    horns: px(2.2, T - 1, 1.2, 1.2, '#e2475f') + px(1.6, T - 2.2, 1, 1.4, '#e2475f') + px(10.6, T - 1, 1.2, 1.2, '#e2475f') + px(11.4, T - 2.2, 1, 1.4, '#e2475f'),
    antenna: px(X + 1.2, T - 3, 0.5, 3, ink) + px(X + 0.8, T - 4, 1.3, 1.3, '#48d6f0') + px(X + 1, T - 3.8, 0.4, 0.4, '#fff'),
    santa: px(X - 2.6, T - 0.6, 5.6, 1.1, '#f4f4f4') + px(X - 2, T - 2, 4.4, 1.5, '#e2475f') + px(X - 0.6, T - 3, 3, 1.1, '#e2475f') + px(X + 2, T - 2.6, 1.1, 1.1, '#e2475f') + px(X + 2.8, T - 2.2, 1.1, 1.1, '#f4f4f4'),
    sprout: px(X + 1.3, T - 2, 0.45, 2, '#1f9d6b') + px(X - 0.2, T - 2.8, 1.5, 0.9, '#3ccf8e') + px(X + 1.7, T - 3.3, 1.7, 1, '#3ccf8e')
  }[hat] || '';

  s += {
    none: '',
    bowtie: px(5.2, 8.9, 1.5, 1.2, '#e2475f') + px(7.3, 8.9, 1.5, 1.2, '#e2475f') + px(6.6, 9.1, 0.8, 0.8, '#b8324a'),
    scarf: px(1.5, 8.6, 11, 1, '#f08a3c') + px(9, 9.4, 1.4, 2, '#f08a3c') + px(9, 10.9, 1.4, 0.4, '#c96a26') + px(3, 8.6, 0.5, 1, '#c96a26', ' opacity=".6"') + px(6, 8.6, 0.5, 1, '#c96a26', ' opacity=".6"'),
    tie: px(6.4, 8.7, 1.2, 0.8, '#2f6fed') + px(6.2, 9.4, 1.6, 1.6, '#2f6fed') + px(6.6, 10.9, 0.8, 0.5, '#2f6fed'),
    sparkles: star(11.2, 0.6, '#f5c542', 0.8) + star(0.4, 2.6, '#f5c542', 0.6) + px(12.6, 4.4, 0.5, 0.5, '#f5c542'),
    hearts: heart(11.3, 1, '#e84fa0') + heart(0.5, 2.8, '#ff9fb5'),
    badge: `<circle cx="10.2" cy="9.3" r="1.1" fill="#f5c542" stroke="${ink}" stroke-width=".3"/>` + px(9.9, 9, 0.6, 0.6, '#e2475f')
  }[extra] || '';
  return s;
}
function avatar(b, size = 36) {
  if (!b) b = { color: '#9aa3ad' };
  return `<span class="avatar" style="width:${size}px;height:${size}px;--c:${esc(b.color)};border-radius:${Math.round(size * 0.28)}px"><svg viewBox="0 0 14 14" width="${Math.round(size * 0.86)}" height="${Math.round(size * 0.86)}" shape-rendering="crispEdges" aria-hidden="true">${critter(b.color, outfit(b))}</svg></span>`;
}
function roomAvatar(r, size = 36) {
  const m = r.members.slice(0, 2).map((id) => bot(id));
  if (m.length < 2) return avatar(m[0], size);
  const s = Math.round(size * 0.66);
  return `<span class="avatar stack" style="width:${size}px;height:${size}px"><span style="left:0;top:0">${avatar(m[0], s)}</span><span style="right:0;bottom:0">${avatar(m[1], s)}</span></span>`;
}
function stamp(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], now - d < 6 * 864e5 ? { weekday: 'long' } : { month: 'short', day: 'numeric' });
}
function timeAgo(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return 'now'; if (d < 3600) return Math.floor(d / 60) + 'm';
  if (d < 86400) return Math.floor(d / 3600) + 'h'; return Math.floor(d / 86400) + 'd';
}
function clock(sec) { return new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function whenNext(ms) {
  const d = new Date(ms), now = new Date();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
  if (d.toDateString() === now.toDateString()) return t;
  const tmr = new Date(now); tmr.setDate(now.getDate() + 1);
  if (d.toDateString() === tmr.toDateString()) return 'Tmr ' + t;
  return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + t;
}
function md(src) {
  const blocks = String(src ?? '').split(/```/);
  return blocks.map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.replace(/^\w*\n/, ''))}</code></pre>`;
    return part.trim().split(/\n{2,}/).map((para) => {
      let h = esc(para)
        .replace(/\[([^\]]+)\]\((\/api\/(?:bots\/\d+\/download|documents\/[a-f0-9-]+\/export)(?:\?[^\s"'<>)]*)?)\)/g, '<a href="$2" download>$1</a>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
        .replace(/(^|\s)@([A-Z][\w]*(?: [A-Z][\w]*)?)/g, '$1<strong class="mention">@$2</strong>');
      if (/^\s*[-*] /m.test(para) && para.split('\n').every((l) => /^\s*[-*] /.test(l) || !l.trim())) {
        return '<ul>' + h.split('\n').filter((l) => l.trim()).map((l) => `<li>${l.replace(/^\s*[-*] /, '')}</li>`).join('') + '</ul>';
      }
      return `<p>${h.replace(/\n/g, '<br>')}</p>`;
    }).join('');
  }).join('');
}
function userName() {
  const e = S.data?.user?.email || '';
  const n = e.split('@')[0] || 'You';
  return n.charAt(0).toUpperCase() + n.slice(1);
}

// ---------- sidebar ----------
let sideQuery = '';
let connectionState=navigator.onLine?'Connecting…':'Offline — instructions stay on this device';
let liveEvents;
const pendingSends=new Map();
function connectionStatus(text){connectionState=text;const el=$('#connection-status');if(el)el.textContent=text;}
let sidebarPrefsKey='',sidebarPrefs={collapsed:{},seen:{},seeded:false,rootCollapsed:false};
const revealedDisplayGroups=new Set();
let revealedOrchestratorBranch=false;
let sidebarDrag=null;
const sidebarLayout=()=>normalizeSidebarLayout(S.data?.sidebarLayout);
function revealDisplayGroup(id){revealedOrchestratorBranch=true;revealedDisplayGroups.add(id);for(const parent of sidebarGroupAncestors(sidebarLayout(),id))revealedDisplayGroups.add(parent);}
const knownDisplayGroups=new Set(DISPLAY_GROUPS.map(group=>group.id));
function displayGroup(bot){return Object.hasOwn(bot,'display_group')?(knownDisplayGroups.has(bot.display_group)?bot.display_group:''):defaultDisplayGroup(bot.template);}
function sidebarPreferences(){
  const identity=String(S.data?.user?.id??S.data?.user?.email??'local'),storageKey='nimbus.sidebar.v1.'+encodeURIComponent(identity);
  if(storageKey!==sidebarPrefsKey){sidebarPrefsKey=storageKey;revealedDisplayGroups.clear();revealedOrchestratorBranch=false;let saved;try{saved=JSON.parse(localStorage.getItem(storageKey)||'null');}catch{}
    sidebarPrefs={collapsed:saved?.collapsed&&typeof saved.collapsed==='object'&&!Array.isArray(saved.collapsed)?saved.collapsed:Object.fromEntries([...DISPLAY_GROUPS.map(group=>group.id),'rooms'].map(group=>[group,true])),seen:saved?.seen&&typeof saved.seen==='object'&&!Array.isArray(saved.seen)?saved.seen:{},seeded:saved?.seeded===true,rootCollapsed:saved?.rootCollapsed===true};
  }
  return sidebarPrefs;
}
function saveSidebarPreferences(){try{localStorage.setItem(sidebarPrefsKey,JSON.stringify(sidebarPrefs));}catch{}}
function lastSignature(last){return last?JSON.stringify([last.at??null,String(last.author??''),String(last.text??'')]):null;}
function syncSidebarSeen(){
  const prefs=sidebarPreferences(),last=S.data?.last||{};let changed=false;
  if(!prefs.seeded){for(const [key,value]of Object.entries(last))prefs.seen[key]=lastSignature(value);prefs.seeded=true;changed=true;}
  for(const [key,value]of Object.entries(last))if(key===threadKey()||value.author==='user'){const signature=lastSignature(value);if(prefs.seen[key]!==signature){prefs.seen[key]=signature;changed=true;}}
  if(changed)saveSidebarPreferences();
}
function unreadThread(key){const last=S.data?.last?.[key];return !!last&&key!==threadKey()&&last.author!=='user'&&sidebarPrefs.seen[key]!==lastSignature(last);}
function orchestratorAgents(){return(S.data?.bots||[]).filter(agent=>agent.template==='orchestrator');}
function rootOrchestrator(){const agents=orchestratorAgents();return agents.length===1?agents[0]:null;}
function revealSidebarThread(key){
  const list=$('.side-list'),item=list?[...list.querySelectorAll('.side-item')].find(row=>row.dataset.key===key):null;if(!list||!item)return;
  if(item.classList.contains('fixed-root')){list.scrollTop=0;return;}
  const bounds=list.getBoundingClientRect(),row=item.getBoundingClientRect(),fixed=list.querySelector('.side-orchestrator'),visibleTop=fixed?Math.max(bounds.top,fixed.getBoundingClientRect().bottom):bounds.top;
  // Scroll this vertical list only; the mobile drawer can be offscreen without
  // moving the document, changing focus or disturbing the current draft.
  if(row.top<visibleTop)list.scrollTop-=visibleTop-row.top+4;
  else if(row.bottom>bounds.bottom)list.scrollTop+=row.bottom-bounds.bottom+4;
}
function sidebarItems(){
  const d=S.data;
  const items = [
    ...d.bots.map((b) => ({ key:'bot:'+b.id,parent:b.parent_bot_id?'bot:'+b.parent_bot_id:null,group:b.template==='orchestrator'?null:displayGroup(b),rootCandidate:b.template==='orchestrator',name:b.name,av:avatar(b,38),state:b.status?.state||'idle',last:d.last['bot:'+b.id],fallback:b.role,created:b.created_at })),
    ...d.rooms.map((r) => ({ key:'room:'+r.id,parent:null,group:'rooms',name:r.name,av:roomAvatar(r,38),state:d.approvals.some(a=>a.thread==='room:'+r.id)?'waiting':r.members.some(id=>bot(id)?.status.state==='working')?'working':'idle',last:d.last['room:'+r.id],fallback:`${r.members.length} agents`,created:r.created_at }))
  ].sort((a,b)=>(b.last?.at||b.created||0)-(a.last?.at||a.created||0));
  // Your own order (from dragging) wins; chats not placed yet stay on top, newest first.
  if(Array.isArray(d.sideOrder)){const pos=new Map(d.sideOrder.map((key,index)=>[key,index]));items.sort((a,b)=>(pos.has(a.key)?pos.get(a.key):-1)-(pos.has(b.key)?pos.get(b.key):-1));}
  return items;
}
function sidebarGroup(group,members,children='',allMembers=members){
  const key=threadKey(),known=new Map(members.map(item=>[item.key,item])),matches=members.filter(item=>!sideQuery||item.name.toLowerCase().includes(sideQuery)),visible=new Set(matches.map(item=>item.key));
  if(sideQuery){for(const match of matches){let parent=match.parent;const visited=new Set();while(parent&&known.has(parent)&&!visited.has(parent)){visited.add(parent);visible.add(parent);parent=known.get(parent).parent;}}if(!matches.length&&!children)return '';}
  const expanded=!!sideQuery||revealedDisplayGroups.has(group.id)||sidebarPrefs.collapsed[group.id]!==true,bodyId='side-display-'+(group.id||'other');
  const current=allMembers.find(item=>item.key===key),working=allMembers.filter(item=>['working','running','routing'].includes(item.state)).length,waiting=allMembers.filter(item=>/^waiting(?:_|$)|^(?:paused|needs_review)$/.test(item.state)).length,queued=allMembers.filter(item=>item.state==='queued').length,unread=allMembers.filter(item=>unreadThread(item.key)).length;
  const ids=new Set(allMembers.map(item=>item.key)),approvals=S.data.approvals.filter(approval=>ids.has(approval.thread)||ids.has('bot:'+approval.bot_id)).length;
  const badges=[current?{kind:'current',text:'Current',label:'Current chat: '+current.name}:null,working?{kind:'working',text:working+' working'}:null,waiting?{kind:'waiting',text:waiting+' waiting'}:null,queued?{kind:'queued',text:queued+' queued'}:null,approvals?{kind:'approval',text:approvals+(approvals===1?' approval':' approvals')}:null,unread?{kind:'unread',text:unread+' unread',label:unread+' unread '+(unread===1?'thread':'threads')}:null].filter(Boolean);
  const unit=allMembers.every(item=>item.key.startsWith('room:'))&&group.id==='rooms'?'group chats':allMembers.some(item=>item.key.startsWith('room:'))?'items':'agents',label=group.label+', '+allMembers.length+' '+unit+(badges.length?', '+badges.map(badge=>badge.label||badge.text).join(', '):'');
  const rows=hierarchyRows(members).filter(item=>!sideQuery||visible.has(item.key));
  return `<section class="side-display-group ${expanded?'expanded':'collapsed'} ${allMembers.length?'':'empty'}" data-display-section="${esc(group.id)}">
    <button type="button" class="side-group-heading" data-display-group="${esc(group.id)}" aria-expanded="${expanded}" aria-controls="${bodyId}" aria-label="${esc(label)}" ${sideQuery?'aria-disabled="true" title="Search results stay expanded until search is cleared"':'title="Drag to move. Drop on another heading to nest. Alt + arrow keys also move groups."'}>
      <span class="side-group-label">${ICON.chevron}<span>${esc(group.label)}</span><span class="side-group-count" aria-hidden="true">${allMembers.length}</span>${sideQuery?`<small>${allMembers.filter(item=>item.name.toLowerCase().includes(sideQuery)).length} matches</small>`:''}</span>
      ${badges.length?`<span class="side-group-badges" aria-hidden="true">${badges.map(badge=>`<span class="side-group-badge side-badge-${badge.kind}" data-group-badge="${badge.kind}">${esc(badge.text)}</span>`).join('')}</span>`:''}
    </button>
    <div class="side-group-members" id="${bodyId}" data-display-group-body="${esc(group.id)}" ${expanded?'':'hidden'}>${rows.map(item=>{
      const unread=unreadThread(item.key),context=sideQuery&&!matches.some(match=>match.key===item.key),orderParent=item.parent&&known.has(item.parent)?item.parent:'',parentOutsideGroup=item.parent&&!known.has(item.parent)?bot(item.parent.slice(4)):null,externalParent=parentOutsideGroup?.id===rootOrchestrator()?.id?null:parentOutsideGroup;
      return `<button class="side-item ${item.depth?'subagent':''} ${key===item.key?'active':''} ${unread?'unread':''} ${context?'search-context':''}" style="--worker-depth:${Math.min(item.depth,4)}" data-open="${item.key}" data-key="${item.key}" data-order-parent="${orderParent}" data-depth="${item.depth}" ${key===item.key?'aria-current="page"':''} ${unread?`aria-label="${esc(item.name)}, unread update"`:''}>
        <span class="av-wrap">${item.av}${item.state!=='idle'?`<span class="dot ${esc(item.state)}"></span>`:''}</span>
        <span class="meta"><span class="row1"><span class="name">${esc(item.name)}</span>${unread?'<span class="side-unread-dot" aria-hidden="true"></span>':''}<span class="time">${item.last?stamp(item.last.at):''}</span></span><span class="sub">${esc(item.last?(item.last.author==='user'?'You: ':'')+item.last.text:item.fallback||'Say hi')}</span>${externalParent?`<span class="side-parent-context">Subagent of ${esc(externalParent.name)}</span>`:''}</span>
      </button>`;
    }).join('')}${children?`<div class="side-group-children">${children}</div>`:''}</div>
  </section>`;
}
function orchestratorRow(item,{ambiguous=false}={}){
  const active=threadKey()===item.key,unread=unreadThread(item.key),preview=item.last?(item.last.author==='user'?'You: ':'')+item.last.text:item.fallback||'Open the Orchestrator chat';
  return `<button type="button" class="side-item fixed-root ${active?'active':''} ${unread?'unread':''}" data-open="${item.key}" data-key="${item.key}" ${active?'aria-current="page"':''} aria-label="${esc(item.name)}${ambiguous?', Orchestrator setup candidate':', configured Hermes/Lumos contact'}${unread?', unread update':''}">
    <span class="av-wrap">${item.av}${item.state!=='idle'?`<span class="dot ${esc(item.state)}"></span>`:''}</span>
    <span class="meta"><span class="row1"><span class="name">${esc(item.name)}</span>${unread?'<span class="side-unread-dot" aria-hidden="true"></span>':''}<span class="time">${item.last?stamp(item.last.at):''}</span></span><span class="side-orchestrator-contact">${ambiguous?'Orchestrator setup candidate':'Configured Hermes/Lumos contact'}</span><span class="sub">${esc(preview)}</span></span>
  </button>`;
}
function sidebarOrchestrator(rootItem,items,sections){
  const agents=items.filter(item=>!item.rootCandidate&&item.key.startsWith('bot:')),branch=items.filter(item=>!item.rootCandidate),current=branch.find(item=>item.key===threadKey()),working=agents.filter(item=>['working','running','routing'].includes(item.state)).length,waiting=agents.filter(item=>/^waiting(?:_|$)|^(?:paused|needs_review)$/.test(item.state)).length,queued=agents.filter(item=>item.state==='queued').length,unread=branch.filter(item=>unreadThread(item.key)).length;
  const agentKeys=new Set(agents.map(item=>item.key)),roomKeys=new Set(branch.filter(item=>item.group==='rooms').map(item=>item.key)),approvals=S.data.approvals.filter(approval=>agentKeys.has('bot:'+approval.bot_id)||roomKeys.has(approval.thread)).length;
  const badges=[current?{kind:'current',text:'Current: '+current.name}:null,working?{kind:'working',text:working+' working'}:null,waiting?{kind:'waiting',text:waiting+' waiting'}:null,queued?{kind:'queued',text:queued+' queued'}:null,approvals?{kind:'approval',text:approvals+(approvals===1?' approval':' approvals')}:null,unread?{kind:'unread',text:unread+' unread threads'}:null].filter(Boolean),expanded=!!sideQuery||revealedOrchestratorBranch||!sidebarPrefs.rootCollapsed,matches=sideQuery?branch.filter(item=>item.name.toLowerCase().includes(sideQuery)).length:0;
  return `<div class="side-orchestrator" data-orchestrator-root>${orchestratorRow(rootItem)}<button type="button" class="side-orchestrator-toggle" data-orchestrator-toggle aria-expanded="${expanded}" aria-controls="side-orchestrator-team" aria-label="${expanded?'Collapse':'Expand'} subordinate team, ${agents.length} agents${badges.length?', '+badges.map(badge=>badge.text).join(', '):''}" ${sideQuery?'aria-disabled="true" title="Search results stay expanded until search is cleared"':''}><span class="side-group-label">${ICON.chevron}<span>Team agents</span><span class="side-group-count" aria-hidden="true">${agents.length}</span>${sideQuery?`<small>${matches} ${matches===1?'match':'matches'}</small>`:''}</span>${badges.length?`<span class="side-group-badges" aria-hidden="true">${badges.map(badge=>`<span class="side-group-badge side-badge-${badge.kind}" data-orchestrator-badge="${badge.kind}">${esc(badge.text)}</span>`).join('')}</span>`:''}</button></div>
  <div class="side-orchestrator-branch" id="side-orchestrator-team" data-orchestrator-body ${expanded?'':'hidden'}>${sections||`<div class="side-empty">${sideQuery?'No team agents or group chats match':'No subordinate agents yet'}</div>`}</div>`;
}
function renderSide() {
  const d=S.data;syncSidebarSeen();
  const items=sidebarItems(),pending=d.approvals.length,scroll=$('.side-list')?.scrollTop||0,focused=document.activeElement,focusGroup=focused?.hasAttribute?.('data-display-group')?focused.getAttribute('data-display-group'):null,focusRoot=focused?.hasAttribute?.('data-orchestrator-toggle'),focusKey=focused?.dataset?.key||null,roots=items.filter(item=>item.rootCandidate);
  const layout=sidebarLayout(),groupItems=id=>items.filter(item=>item.group===id||sidebarGroupAncestors(layout,item.group).includes(id));
  const section=id=>{const group=SIDEBAR_GROUPS.find(group=>group.id===id),children=layout.groups.filter(child=>child.parent===id).map(child=>section(child.id)).join('');return sidebarGroup(group,items.filter(item=>item.group===id),children,groupItems(id));};
  const renderedSections=layout.groups.filter(group=>group.parent===null).map(group=>section(group.id)).join('');
  const sections=sideQuery&&!renderedSections?'':'<div class="side-group-root-drop" data-sidebar-root-drop>Move group to top level</div>'+renderedSections+(!sideQuery&&!items.some(item=>!item.rootCandidate)?'<div class="side-empty">No subordinate agents or group chats yet.</div>':'');
  const ordering=sideQuery?'':(d.sideOrder?'<button class="side-reset" data-act="side-recent">↺ Sort agents by recent activity</button>':'')+'<div class="side-hint">Drag agents between groups. Drag headings to reorder; drop on a heading’s middle to nest.</div>';
  const grouped=sections?sections+ordering:sideQuery?'<div class="side-empty">No agents or group chats match</div>':`<div class="side-empty">No bots yet.<br><button class="link" data-act="market">Browse the Marketplace</button> or <button class="link" data-act="new-bot">make one</button>.</div>`;
  const sidebarBody=roots.length===1?sidebarOrchestrator(roots[0],items,sections+ordering):roots.length>1?`<section class="side-orchestrator-warning" role="note"><b>Orchestrator setup needs attention</b><p>${roots.length} agents use the Orchestrator profile. Choose the intended root in setup; no root has been selected automatically.</p>${roots.map(item=>orchestratorRow(item,{ambiguous:true})).join('')}</section>${grouped}`:grouped;
  $('#side').innerHTML = `
    <div class="side-top">
      <label class="search">${ICON.search}<input id="side-search" placeholder="Search" value="${esc(sideQuery)}" autocomplete="off"></label>
      <button class="icon-btn" data-act="new-menu" aria-label="New">${ICON.plus}</button>
    </div>
    <div class="side-list">
      ${sidebarBody}<div class="sr" id="sidebar-move-status" role="status" aria-live="polite"></div>
    </div>
    ${sideQuery.length >= 2 ? `<div class="side-hits" id="side-hits"><div class="side-empty">Searching messages…</div></div>` : ''}
    <div class="side-foot"><button class="foot-item" data-act="team">${ICON.monitor}<span>Team overview</span></button>
      <small id="connection-status" class="connection-status" role="status">${esc(connectionState)}</small>
      ${pending ? `<button class="foot-item" data-act="panel">${ICON.bell}<span>Approvals</span><span class="badge">${pending}</span></button>` : ''}
      <button class="foot-item" data-act="market">${ICON.grid}<span>Marketplace</span></button>
      <button class="foot-item user" data-act="user-menu"><span class="initial">${esc(userName()[0])}</span><span>${esc(userName())}</span></button>
    </div>`;
  $('.side-list').scrollTop=scroll;
  if(focusRoot)document.querySelector('[data-orchestrator-toggle]')?.focus({preventScroll:true});
  else if(focusGroup!==null)[...document.querySelectorAll('[data-display-group]')].find(button=>button.getAttribute('data-display-group')===focusGroup)?.focus({preventScroll:true});
  else if(focusKey)[...document.querySelectorAll('.side-item')].find(button=>button.dataset.key===focusKey&&!button.closest('[hidden]'))?.focus({preventScroll:true});
}

const _renderSide = renderSide;
renderSide = function () {
  if (sidebarDrag?.active) return; // don't rebuild the list under your finger mid-drag
  _renderSide(); if (sideQuery.length >= 2) searchMessages(); // keep message hits after re-renders
};

// ---------- sidebar display moves ----------
sidebarDrag=installSidebarDrag({state:()=>S.data,items:sidebarItems,filtered:()=>!!sideQuery,api,toast,buzz,refresh:refreshState,render:()=>renderSide(),reveal:revealDisplayGroup});

// ---------- activity drawer ----------
function renderAside() {
  const d = S.data;
  const pct = d.usage.budget ? Math.min(100, Math.round((d.usage.windowCost / d.usage.budget) * 100)) : null;
  $('#aside').innerHTML = `
    <div class="aside-head"><b>Activity</b><button class="icon-btn" data-act="panel" aria-label="Close">${ICON.close}</button></div>
    <section>
      <h4>Approvals ${d.approvals.length ? `<span class="badge">${d.approvals.length}</span>` : ''}</h4>
      ${d.approvals.length ? d.approvals.map((a) => `
        <button class="card-item" data-open="${esc(a.thread)}">${avatar(bot(a.bot_id), 26)}<span><small>${esc(bot(a.bot_id)?.name)} · ${timeAgo(a.created_at)}</small>${esc(describeTool(a.tool, a.input))}</span></button>`).join('')
        : '<div class="muted">Nothing waiting on you.</div>'}
    </section>
    <section>
      <h4>Up next</h4>
      ${d.upNext.length ? d.upNext.map((r) => `<div class="sched"><span>${whenNext(r.next)}</span><span>${esc(bot(r.bot_id)?.name)} · ${esc(r.prompt.slice(0, 60))}</span></div>`).join('')
        : '<div class="muted">No routines yet.</div>'}
    </section>
    <section>
      <h4>Learned recently</h4>
      ${d.learned.length ? d.learned.map((l) => `<div class="learned">“${esc(l.text)}” <span class="muted">· ${esc(bot(l.botId)?.name)}</span></div>`).join('')
        : '<div class="muted">When you tell a bot a rule, it shows up here.</div>'}
    </section>
    ${d.usage.byBot?.length ? `<section><h4>Usage by bot · 7 days</h4>${(() => { const total = d.usage.byBot.reduce((a, x) => a + x.cost, 0) || 1;
      return d.usage.byBot.slice(0, 6).map((x) => { const b = bot(x.bot_id); const pc = Math.round((x.cost / total) * 100);
        return `<div class="ubot">${avatar(b, 20)}<span class="un">${esc(b?.name || 'Deleted bot')}</span><span class="muted">${x.runs} runs · ${b ? esc(EFFORTS.find((e) => e[0] === b.effort)?.[1] || b.effort) : ''}</span><b>${pc}%</b></div>
          <div class="meter thin"><div style="width:${pc}%"></div></div>`; }).join(''); })()}
      <div class="muted small">Heavy bots on High or Max effort usually do fine on Medium for routine work.</div></section>` : ''}
    <section class="usage" id="usage-box">${usageFallback(d, pct)}</section>`;
  loadPlanUsage();
}

// Plan usage: the real % of your OpenAI subscription's limits left (like /usage in Codex).
// Missing usage information is shown as unknown, never as an API charge.
function usageFallback(d, pct) {
  return `<h4>OpenAI subscription</h4><div class="muted">Usage status is not available yet. Local capacity remains available.</div>`
    + `<div class="muted">${d.usage.running} running · ${d.bots.filter((b) => b.status.state === 'working').length} bots busy</div>`;
}
let planLast = null, planAt = 0;
async function loadPlanUsage() {
  if (planLast) drawPlanUsage(planLast);
  if (Date.now() - planAt < 60_000) return;
  planAt = Date.now();
  try { planLast = await api('/api/plan-usage'); } catch { planLast = { ok: false }; }
  drawPlanUsage(planLast);
}
function resetsIn(iso) {
  const m = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return new Date(iso).toLocaleDateString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
function drawPlanUsage(p) {
  const box = $('#usage-box'); if (!box || !p?.ok) return;
  const d = S.data;
  box.innerHTML = `<h4>OpenAI subscription${p.plan ? ` · ${esc(p.plan[0].toUpperCase() + p.plan.slice(1))}` : ''}</h4>` + p.windows.map((w) => {
    const left = Math.max(0, Math.round(100 - w.used));
    return `<div class="row"><span>${esc(w.label)}</span><span><b>${left}% left</b></span></div>
      <div class="meter ${w.used >= 90 ? 'hot' : w.used >= 70 ? 'warm' : ''}"><div style="width:${Math.min(100, w.used)}%"></div></div>
      <div class="muted small">${Math.round(w.used)}% used${w.resets ? ` · resets in ${resetsIn(w.resets)}` : ''}</div>`;
  }).join('') + `<div class="muted">${d.usage.running} running · ${d.bots.filter((b) => b.status.state === 'working').length} bots busy</div>`;
}

// ---------- main ----------
function renderMain() {
  const main = $('#main');
  if (!S.current) {
    const none = !S.data.bots.length;
    main.innerHTML = `<header class="head"><button class="icon-btn menu-btn" data-act="menu" aria-label="Menu">${ICON.menu}</button></header>
      <div class="thread"><div class="empty">
        <img class="logo-art" src="/nimbus.webp" alt="Nimbus" width="160" height="160">
        <h2>${none ? 'Build your team' : 'Pick a bot to talk to'}</h2>
        <p>${none ? 'Workers share local inference and use your OpenAI subscription when the task needs it. Each has its own workspace and browser group.' : 'Hand off a task. You’ll see each step, and it’ll check with you before sending, paying, deleting or merging.'}</p>
        ${none ? `<div class="row"><button class="btn primary" data-act="market">${ICON.grid} Browse Marketplace</button><button class="btn" data-act="new-bot">${ICON.plus} New bot</button></div>` : ''}
      </div></div>`;
    return;
  }
  const isBot = S.current.type === 'bot';
  const b = isBot ? bot(S.current.id) : null;
  const r = !isBot ? room(S.current.id) : null;
  if (!b && !r) { S.current = null; return renderMain(); }
  const nRoutines = isBot ? S.data.routines.filter((x) => x.bot_id === b.id).length : 0;
  const pending = S.data.approvals.length;
  main.innerHTML = `
    <header class="head">
      <button class="icon-btn menu-btn" data-act="menu" aria-label="Menu">${ICON.menu}</button>
      <button class="title" data-act="${isBot ? 'edit-bot' : 'edit-room'}">
        ${isBot ? avatar(b, 24) : roomAvatar(r, 24)}
        <b>${esc(isBot ? b.name : r.name)}</b>
        ${isBot && b.status.state !== 'idle' ? `<span class="status ${b.status.state}">${esc(b.status.label)}</span>` : ''}
      </button>
      <div class="actions">
        ${isBot ? `
          <label class="effort" title="Effort: higher is smarter but uses more of your plan">
            <button class="effort-btn" data-act="effort-menu" aria-label="Effort" aria-haspopup="menu">${esc(EFFORTS.find(([v]) => v === b.effort)?.[1] || 'Medium')}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 9 6 6 6-6"/></svg></button>
          </label>
          <button class="icon-btn" data-act="routines" title="Routines" aria-label="Routines">${ICON.clock}${nRoutines ? `<i class="count">${nRoutines}</i>` : ''}</button>
          ${b.computer && S.data.computers ? `<button class="icon-btn" data-act="computer" title="${esc(b.name)}’s computer" aria-label="Computer">${ICON.monitor}</button>` : ''}
          <button class="icon-btn" data-act="plugins" title="Plugins" aria-label="Plugins">${ICON.plug}${b.plugins.length ? `<i class="count">${b.plugins.length}</i>` : ''}</button>
          <button class="icon-btn" data-act="memory" title="Memory" aria-label="Memory">${ICON.book}</button>
          <button class="icon-btn" data-act="reset" title="New chat (memory is kept)" aria-label="New chat">${ICON.compose}</button>
          <button class="icon-btn" data-act="edit-bot" title="Settings" aria-label="Settings">${ICON.gear}</button>`
        : `<button class="icon-btn" data-act="edit-room" title="Settings" aria-label="Settings">${ICON.gear}</button>`}
        <button class="icon-btn" data-act="panel" title="Activity" aria-label="Activity">${ICON.bell}${pending ? `<i class="count hot">${pending}</i>` : ''}</button>
      </div>
    </header>
    <div class="thread" id="thread"><div class="thread-inner">${renderMessages()}</div></div>
    <div class="composer">
      <div class="attach-list" id="attach-list"></div>
      <form id="composer">
        <button type="button" class="plus" data-act="${isBot ? 'plugins' : 'edit-room'}" aria-label="${isBot ? 'Plugins' : 'Chat settings'}">${ICON.plus}</button>
        <button type="button" class="plus" data-act="attach" aria-label="Attach files">${ICON.clip}</button>
        <button type="button" class="plus mic" data-act="dictate" aria-label="Dictate" title="Dictate (tap to start, tap to stop)">${ICON.mic}</button>
        <input type="file" id="file-pick" multiple hidden>
        <label for="msg" class="sr">Message</label>
        <textarea id="msg" rows="1" placeholder="${isBot ? `Message ${esc(b.name)}` : `Message ${esc(r.name)} · @ a bot to direct it`}"></textarea>
        <button class="send" aria-label="Send">${ICON.send}</button>
      </form>
    </div>`;
  attachAutocorrect($('#msg'));
  if (isRecording() || browserStop) micState('recording'); // re-render during dictation
  const th = $('#thread');
  th.scrollTop = th.scrollHeight;
  const ta = $('#msg');
  const draft = sessionDraft.get(threadKey());
  if (draft) ta.value = draft;
  autosize(ta);
  if (matchMedia('(min-width: 761px)').matches) ta.focus();
}
const sessionDraft = new Map();
function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px'; }

function renderMessages() {
  if (S.loadingThread) return '<div class="empty small">Loading…</div>';
  if (!S.messages.length) {
    const isBot = S.current.type === 'bot';
    const b = isBot ? bot(S.current.id) : null;
    return `<div class="empty">${isBot ? avatar(b, 72) : roomAvatar(room(S.current.id), 72)}<h2>${esc(isBot ? b.name : room(S.current.id).name)}</h2><p>${isBot ? esc(b.role || 'Give this bot a task. It’ll ask before sending, paying, deleting or merging.') : 'Post a goal. The lead bot splits the work, and bots @mention each other to hand things off.'}</p></div>`;
  }
  return S.messages.map((m, i) => renderMessage(m, S.messages[i - 1])).join('');
}

// Show the bot's name above its bubble in group chats, when the speaker changes.
function speakerLabel(m, prev) {
  if (S.current?.type !== 'room' || m.author === 'user') return '';
  if (prev && prev.author === m.author && prev.kind !== 'note') return '';
  const b = bot(m.author);
  return `<div class="speaker">${avatar(b, 18)}<span style="color:${esc(b?.color || '#999')}">${esc(b?.name || 'Deleted bot')}</span></div>`;
}
const fileUrl = (f) => `/api/files/${f.id}/${encodeURIComponent(f.name)}`;
const isImage = (f) => /^image\/(png|jpe?g|gif|webp|avif)$/.test(f.type);
function renderFiles(m) {
  let files = [];
  try { files = JSON.parse(m.files || '[]'); } catch {}
  if (!files.length) return '';
  return `<div class="files">${files.map((f) => isImage(f)
    ? `<a class="file-img" href="${fileUrl(f)}" target="_blank" rel="noopener"><img src="${fileUrl(f)}" alt="${esc(f.name)}" loading="lazy"></a>`
    : `<a class="file-chip" href="${fileUrl(f)}" download="${esc(f.name)}">${ICON.clip}<span>${esc(f.name)}</span><small>${fmtSize(f.size)}</small></a>`).join('')}</div>`;
}
function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

// ---------- right-click (or long-press) a message: redact ----------
document.addEventListener('contextmenu', (e) => {
  const msg = e.target.closest('#thread .msg[data-mid], #thread .note[data-mid]');
  if (!msg || drag) return;
  const bubble = msg.querySelector('.bubble, .approval, .trace') || msg;
  const sel = String(getSelection() || '').trim();
  const inside = sel && getSelection().anchorNode && bubble.contains(getSelection().anchorNode);
  e.preventDefault();
  closePopover();
  const id = Number(msg.dataset.mid);
  const el = document.createElement('div');
  el.className = 'popover';
  el.innerHTML = `${inside ? `<button data-redact-sel>${ICON.lock}<span>Redact “${esc(sel.length > 24 ? sel.slice(0, 24) + '…' : sel)}”</span></button>` : ''}
    <button data-redact-all>${ICON.lock}<span>Redact whole message</span></button>
    <button data-copy-msg>${ICON.check}<span>Copy</span></button>`;
  document.body.append(el);
  el.style.left = Math.max(8, Math.min(e.clientX, innerWidth - el.offsetWidth - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(e.clientY, innerHeight - el.offsetHeight - 8)) + 'px';
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    closePopover();
    const m = S.messages.find((x) => x.id === id);
    if (b.dataset.copyMsg !== undefined) { await navigator.clipboard?.writeText(m?.body || '').catch(() => {}); return toast('Copied'); }
    const text = b.dataset.redactSel !== undefined ? sel : '';
    if (!confirm(text ? `Replace “${text.slice(0, 80)}” with [REDACTED] everywhere Nimbus stored it?` : 'Replace this whole message with [REDACTED]? It’s also removed from saved prompts and bot transcripts.')) return;
    try {
      const r = await api(`/api/messages/${id}/redact`, { method: 'POST', body: { text } });
      buzz(10); toast(`Redacted${r.transcripts ? ` (also in ${r.transcripts} transcript${r.transcripts > 1 ? 's' : ''})` : ''}`);
    } catch (err) { toast(err.message); }
  });
});

// ---------- slash commands in the message box ----------
const SLASH = [['/new', 'Start a fresh chat with this bot (memory is kept)']];
function slashHint(v) {
  let box = $('#slash-hint');
  const show = S.current?.type === 'bot' && /^\/\w*$/.test(v);
  const items = show ? SLASH.filter(([c]) => c.startsWith(v.toLowerCase())) : [];
  if (!items.length) return box?.remove();
  if (!box) { box = document.createElement('div'); box.id = 'slash-hint'; box.className = 'slash-hint'; $('.composer').prepend(box); }
  box.innerHTML = items.map(([c, d]) => `<button type="button" data-slash="${c}"><b>${c}</b><span>${d}</span></button>`).join('');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-slash]'); if (!b) return;
  const ta = $('#msg'); ta.value = b.dataset.slash; $('#slash-hint')?.remove(); $('#composer').requestSubmit();
});

// ---------- read aloud ----------
// Plays a bot reply spoken by Piper on the server. Tapping again (or another reply) stops it.
let speaking = null; // { audio, btn }
async function speak(btn) {
  const same = speaking?.btn === btn;
  if (speaking) { speaking.audio.pause(); speaking.btn.textContent = '▶ Read aloud'; speaking = null; }
  if (same) return;
  btn.textContent = '… Loading';
  try {
    const r = await fetch('/api/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId: Number(btn.dataset.speak) }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Couldn’t read that aloud');
    const audio = new Audio(URL.createObjectURL(await r.blob()));
    speaking = { audio, btn };
    btn.textContent = '■ Stop';
    audio.onended = () => { if (speaking?.audio === audio) { btn.textContent = '▶ Read aloud'; speaking = null; } };
    await audio.play();
  } catch (err) { btn.textContent = '▶ Read aloud'; toast(err.message); }
}
function flashMessage(id) {
  const el = document.querySelector(`[data-mid="${id}"]`);
  if (!el) return toast('That message is further back in the chat');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2200);
}

// ---------- share from other apps (Android app) ----------
// The app calls this with { text, files: [{ name, type, data (base64) }] }; you pick which bot gets it.
window.nimbusShare = (share) => {
  if (!S.data) { setTimeout(() => window.nimbusShare(share), 500); return; }
  const files = (share.files || []).map((f) => {
    const bin = atob(f.data), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], f.name || 'shared-file', { type: f.type || '' });
  });
  const what = [share.text ? 'text' : '', files.length ? `${files.length} file${files.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ');
  const el = modal(`<div class="modal-head"><h2>Share ${esc(what)} with…</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <div class="stack-list">${S.data.bots.map((b) => `<button class="card-item" data-share-to="bot:${b.id}">${avatar(b, 30)}<span><b>${esc(b.name)}</b><small>${esc(b.role || '')}</small></span></button>`).join('')}</div>`);
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return closeModal();
    const t = e.target.closest('[data-share-to]'); if (!t) return;
    closeModal();
    await openThread(t.dataset.shareTo);
    const ta = $('#msg');
    if (share.text && ta) { ta.value = share.text.trim(); autosize(ta); }
    if (files.length) addFiles(files);
    ta?.focus();
  });
};

// ---------- dictation ----------
// Tap the mic to start, tap again to stop; the text lands at the cursor for you to edit before sending.
let browserStop = null;
function insertAtCursor(text) {
  const ta = $('#msg'); if (!ta || !text) return;
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
  const before = ta.value.slice(0, a), after = ta.value.slice(b);
  const piece = (before && !/\s$/.test(before) ? ' ' : '') + text.trim() + (after && !/^\s/.test(after) ? ' ' : '');
  ta.value = before + piece + after;
  const pos = before.length + piece.length;
  ta.focus(); ta.setSelectionRange(pos, pos); autosize(ta);
}
function micState(state) {
  const btn = $('.composer .mic'); if (!btn) return;
  btn.classList.toggle('recording', state === 'recording');
  btn.classList.toggle('busy', state === 'busy');
  btn.setAttribute('aria-label', state === 'recording' ? 'Stop dictation' : 'Dictate');
  if (state !== 'recording') btn.style.removeProperty('--level');
}
async function finishDictation() {
  micState('busy');
  try { insertAtCursor(await stopRecording(api)); }
  catch (err) {
    toast(err.message);
  } finally { micState('idle'); }
}
async function toggleDictation(btn) {
  buzz(10);
  if (browserStop) { browserStop(); browserStop = null; return micState('idle'); }
  if (isRecording()) return finishDictation();
  if (btn.classList.contains('busy')) return;
  if (S.whisper === undefined) S.whisper = (await api('/api/transcribe').catch(() => ({}))).available;
  if (!S.whisper) {
    // Server dictation is off: use the browser's own recognition if it has one.
    browserStop = browserDictation(insertAtCursor, () => { browserStop = null; micState('idle'); });
    if (browserStop) { micState('recording'); return toast('Using your browser’s dictation (server dictation is off)'); }
    return toast('Dictation isn’t available right now');
  }
  try {
    await startRecording({
      onLevel: (p) => btn.style.setProperty('--level', Math.min(1, p * 3).toFixed(2)),
      onLimit: () => { toast('Stopped at 5 minutes'); finishDictation(); }
    });
    micState('recording');
  } catch (err) {
    cancelRecording();
    toast(err.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your browser’s site settings.' : err.message);
  }
}

// ---------- attachments ----------
// Files upload as soon as they're picked, pasted or dropped; Send includes the finished ones.
let attachments = []; // { key, name, type, size, id?, error?, preview? }
function drawAttachments() {
  const el = $('#attach-list'); if (!el) return;
  el.innerHTML = attachments.map((a) => `<span class="attach ${a.id ? '' : a.error ? 'bad' : 'busy'}" title="${esc(a.error || a.name)}">
    ${a.preview ? `<img src="${a.preview}" alt="">` : ICON.clip}<span>${esc(a.name)}</span><small>${a.error ? 'Failed' : a.id ? fmtSize(a.size) : 'Uploading…'}</small>
    <button type="button" data-unattach="${a.key}" aria-label="Remove ${esc(a.name)}">${ICON.close}</button></span>`).join('');
}
function addFiles(list) {
  for (const file of list) {
    if (attachments.length >= 10) { toast('Up to 10 files per message'); break; }
    if (file.size > 20 * 1024 * 1024) { toast(`${file.name} is over 20 MB`); continue; }
    const a = { key: Math.random().toString(36).slice(2), name: file.name || 'pasted-image.png', type: file.type, size: file.size,
      preview: /^image\//.test(file.type) ? URL.createObjectURL(file) : null };
    attachments.push(a);
    const reader = new FileReader();
    reader.onload = async () => {
      try { Object.assign(a, await api('/api/uploads', { method: 'POST', body: { name: a.name, type: a.type, data: String(reader.result).split(',')[1] || '' } })); }
      catch (err) { a.error = err.message; }
      drawAttachments();
    };
    reader.readAsDataURL(file);
  }
  drawAttachments();
}
function clearAttachments() {
  for (const a of attachments) if (a.preview) URL.revokeObjectURL(a.preview);
  attachments = []; drawAttachments();
}

function renderMessage(m, prev) {
  if (m.author === 'user') return `<div class="msg user" data-mid="${m.id}">${renderFiles(m)}${m.body ? `<div class="bubble">${esc(m.body)}</div>` : ''}
    ${m.body ? `<div class="msg-actions"><button data-copy="${m.id}" title="Copy">Copy</button><button data-edit="${m.id}" title="Edit and resend">Edit</button><button data-retry="${m.id}" title="Send again">Retry</button></div>` : ''}</div>`;
  if (m.kind === 'note') return `<div class="note" data-mid="${m.id}">${esc(m.body)}</div>`;
  if (m.kind === 'quiet') return `<div class="note quiet-ok" data-mid="${m.id}" title="Quiet check at ${clock(m.created_at)}">✓ All clear · ${esc(m.body)} <span class="muted">· ${clock(m.created_at)}</span></div>`;
  const b = bot(m.author) || { name: 'Deleted bot', color: '#555' };
  if (m.kind === 'trace') return renderTrace(m, prev);
  if (m.kind === 'approval') return renderApproval(m, b, prev);
  if(m.kind==='capability'){
    const request=JSON.parse(m.body);
    return `<div class="msg bot" data-mid="${m.id}"><section class="runtime-capability-card compact"><div class="runtime-capability-heading"><b>${esc(request.title||'Tool development')}</b><span class="task-status ${esc(request.status)}">${esc(String(request.status||'queued').replaceAll('_',' '))}</span></div><p class="runtime-capability-message">${esc(request.message||'')}</p><div class="runtime-capability-meta"><code>${esc(request.toolName||'')}</code><button class="btn small" data-tool-development="${esc(request.requestId)}">View progress</button></div></section></div>`;
  }
  if (m.kind === 'question') {
    const q=JSON.parse(m.body),pending=q.status==='pending';
    return `<div class="msg bot" data-mid="${m.id}">${speakerLabel(m,prev)}<div class="approval" data-question-id="${q.questionId}"><b>${pending?'Your input is needed':esc(q.status)}</b>${q.questions.map((item,index)=>`<label class="field">${esc(item.question)}${pending?`${item.options?.length?`<select data-question-choice="${index}"><option value="">Choose an answer or type below</option>${item.options.map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`:''}<textarea data-question-answer="${index}" rows="2"></textarea>`:`<p>${esc(q.answers?.[index]||'No answer recorded')}</p>`}</label>`).join('')}${pending?'<button class="btn primary" data-answer-question>Submit answers</button>':''}</div></div>`;
  }
  return `<div class="msg bot ${m.kind === 'error' ? 'error' : ''}" data-mid="${m.id}" title="${clock(m.created_at)}">${speakerLabel(m, prev)}<div class="bubble md">${md(m.body)}</div>
    <div class="msg-actions"><button data-copy="${m.id}">Copy</button>${m.kind === 'error' ? '<button data-continue="1">Try again</button>' : `<button data-speak="${m.id}">▶ Read aloud</button><button data-continue="1">Continue</button>`}</div></div>`;
}

// While a bot works, the label cycles through cloud-themed phrases. The phrase is picked from the
// elapsed time, so re-renders never make it jump, and every live trace stays in step.
const WORK_PHRASES = ['Thinking', 'Gathering clouds', 'Connecting the dots', 'Drifting through ideas', 'Brewing a plan',
  'Reading the sky', 'Condensing thoughts', 'Tinkering', 'Chasing a hunch', 'Weaving it together', 'Polishing', 'Almost there, probably'];
const PHRASE_MS = 3500;
// Clamped at 0: the server's clock can be ahead of this device's, which made the index negative ("undefined").
const elapsedMs = (started) => Math.max(0, Date.now() - (Number(started) || Date.now()));
const workPhrase = (started) => WORK_PHRASES[Math.floor(elapsedMs(started) / PHRASE_MS) % WORK_PHRASES.length];
const fmtDur = (secs) => (secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`);
const LOADER = '<span class="loader" aria-hidden="true"><i></i><i></i><i></i></span>';

// Run stats instead of a dollar figure: tokens used, how full the context is, and plan usage left.
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
function traceStats(t) {
  const bits = [];
  if(t.model) bits.push(`<span>${esc(t.model)}</span>`);
  if (t.tokens && typeof t.tokens==='object') bits.push(`<span title="Tokens read / written this run (including cached context)">${fmtTok(t.tokens.in)} in · ${fmtTok(t.tokens.out)} out</span>`);
  else if(typeof t.tokens==='number')bits.push(`<span>${fmtTok(t.tokens)} tokens</span>`);
  if (t.context && t.contextWindow) {
    const win = t.contextWindow, pc = Math.min(100, Math.round((t.context / win) * 100));
    bits.push(`<span class="ctx ${pc >= 80 ? 'hot' : pc >= 60 ? 'warm' : ''}" title="Context in use: ${t.context.toLocaleString()} of ${win.toLocaleString()} tokens. Near full, start a New chat (memory is kept).">ctx ${pc}%</span>`);
  }
  const five = planLast?.ok && planLast.windows.find((w) => w.label === '5-hour limit');
  if (five && t.status !== 'running') bits.push(`<span title="OpenAI subscription: 5-hour limit left right now">${Math.max(0, Math.round(100 - five.used))}% left</span>`);
  return bits.length ? ' · ' + bits.join(' · ') : '';
}

function renderTrace(m, prev) {
  const t = JSON.parse(m.body);
  const running = t.status === 'running';
  if (t.status === 'done' && !t.steps.length && !t.model) return `<div data-mid="${m.id}" hidden></div>`;
  const secs = Math.round((t.ended ? Math.max(0, t.ended - t.started) : elapsedMs(t.started)) / 1000);
  const dur = fmtDur(secs);
  const mark = { done: '✓', waiting: '⏸', error: '✗', rejected: '✗', stopped: '■', running: '' };
  const waiting = running && t.steps.some((s) => s.state === 'waiting');
  const label = running ? (waiting ? (t.steps.some(s=>s.tool==='request_user_input'&&s.state==='waiting')?'Waiting for your answer':'Waiting for your approval') : t.source === 'auto-compact' || t.compacting ? '<span class="shimmer">Compacting the chat…</span>' : `<span class="shimmer" data-phrase>${workPhrase(t.started)}</span>`) :
    t.status === 'done' ? `${t.steps.length} step${t.steps.length === 1 ? '' : 's'}` : t.status === 'waiting_tool'?'Waiting for a new tool':t.status === 'stopped' ? 'Stopped' : t.status === 'interrupted' ? 'Interrupted' : t.status === 'paused' ? 'Task paused' : t.status === 'needs_review' ? 'Action needs review' : 'Run failed';
  const open = running || openTraces.has(m.id);
  return `<div class="msg bot" data-mid="${m.id}">${speakerLabel(m, prev)}<details class="trace ${running ? 'live' : ''} ${waiting ? 'paused' : ''}" ${open ? 'open' : ''} data-started="${t.started}">
    <summary>${running ? LOADER : ICON.chevron}<span>${label}</span><span class="sp"><span data-dur>${dur}</span>${traceStats(t)}</span>${running ? `<button class="stop" data-stop="${m.run_id}">Stop</button>` : ''}</summary>
    <div class="steps">
      ${t.plan?`<div class="task-plan">${t.plan.explanation?`<p>${esc(t.plan.explanation)}</p>`:''}<ol>${t.plan.steps.map(s=>`<li>${s.status==='completed'?'✓ ':s.status==='in_progress'?'→ ':''}${esc(s.step)}</li>`).join('')}</ol></div>`:''}
      ${t.steps.map((s) => `<div class="step"><span class="mark ${s.state}">${mark[s.state] ?? ''}</span><span>${esc(s.text)}</span></div>`).join('')}
      ${running && t.lastThought ? `<div class="thought">${esc(t.lastThought)}</div>` : ''}
    </div>
  </details></div>`;
}
const openTraces = new Set();
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-tool-development]');if(!button)return;
  try{await runtimeUI.toolRequest(button.dataset.toolDevelopment);}catch(error){toast(error.message);}
});
document.addEventListener('change',e=>{
  if(!e.target.matches('[data-question-choice]'))return;
  const box=e.target.closest('[data-question-id]');box.querySelector(`[data-question-answer="${e.target.dataset.questionChoice}"]`).value=e.target.value;
});
document.addEventListener('click',async e=>{
  const button=e.target.closest('[data-answer-question]');if(!button)return;
  const box=button.closest('[data-question-id]'),answers=[...box.querySelectorAll('[data-question-answer]')].map(f=>f.value.trim());
  if(answers.some(a=>!a))return toast('Answer each question before submitting');
  button.disabled=true;
  try{await api(`/api/questions/${box.dataset.questionId}/answer`,{method:'POST',body:{answers}});toast('Answers sent');}
  catch(error){button.disabled=false;toast(error.message);}
});

function renderApproval(m, b, prev) {
  const a = JSON.parse(m.body);
  const pending = a.status === 'pending';
  const input = a.tool === 'shell' ? a.input.command : JSON.stringify(a.input, null, 2);
  const done = { approved: 'Approved', rejected: 'Rejected', expired: 'Expired' }[a.status];
  return `<div class="msg bot" data-mid="${m.id}">${speakerLabel(m, prev)}<div class="approval ${pending ? '' : 'decided'}">
    <div class="label">${ICON.lock} ${pending ? 'Needs your approval' : done}</div>
    <div>${esc(describeTool(a.tool, a.input).split(' — ')[0].replace(/^Run: .*/, 'Run a command'))}</div>
    <pre>${esc(input)}</pre>
    ${a.note ? `<div class="muted">Your note: ${esc(a.note)}</div>` : ''}
    ${pending ? `<div class="row">
      <button class="btn primary" data-approve="${a.approvalId}">Approve</button>
      <button class="btn" data-reject="${a.approvalId}">Reject…</button>
      <label>Then <select data-remember="${a.approvalId}">
        <option value="">ask again next time</option>
        <option value="exact">always allow ${a.tool === 'shell' ? 'this exact command' : 'this tool'}</option>
        ${a.pattern ? `<option value="pattern">always allow “${esc(a.pattern)}”</option>` : ''}
      </select></label>
    </div>` : ''}
  </div></div>`;
}

// ---------- navigation ----------
async function openThread(key) {
  const [type, id] = key.split(':');
  const prev = threadKey();
  if (prev) sessionDraft.set(prev, $('#msg')?.value || '');
  S.current = { type, id: Number(id) };
  sidebarPreferences();sideQuery='';const target=type==='bot'?bot(id):null;if(target?.template!=='orchestrator')revealDisplayGroup(type==='room'?'rooms':displayGroup(target||{}));syncSidebarSeen();
  history.replaceState(null, '', '#' + key);
  S.loadingThread = true; S.messages = [];
  $('#side').classList.remove('open'); $('#aside').classList.remove('open');
  renderSide();revealSidebarThread(key);renderMain();
  S.messages = await api(`/api/threads/${encodeURIComponent(key)}/messages`);
  S.loadingThread = false;
  if (threadKey() === key) { renderMain(); $('.thread-inner')?.classList.add('fade-in'); }
}

let stateSeq = 0;
async function refreshState() {
  // Overlapping refreshes can finish out of order; only the newest one wins.
  const seq = ++stateSeq;
  const data = await api('/api/state');
  if (seq !== stateSeq) return;
  S.data = data;
  const focused = document.activeElement?.id === 'side-search';
  renderSide(); renderAside();
  if (focused) { const i = $('#side-search'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
}

// ---------- live updates ----------
function connect() {
  liveEvents?.close();const es=liveEvents=new EventSource('/api/events');
  es.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.thread === threadKey() && !S.messages.some((x) => x.id === m.id)) {
      const prev = S.messages[S.messages.length - 1];
      S.messages.push(m);
      const th = $('#thread');
      if (!th) return;
      const nearBottom = th.scrollHeight - th.scrollTop - th.clientHeight < 200;
      const inner = $('.thread-inner', th);
      if (S.messages.length === 1) inner.innerHTML = '';
      inner.insertAdjacentHTML('beforeend', renderMessage(m, prev));
      inner.lastElementChild?.classList.add('enter');
      if (m.author !== 'user' && m.kind === 'text') buzz(6);
      if (nearBottom || m.author === 'user') th.scrollTop = th.scrollHeight;
    }
    if (m.kind === 'approval' && m.author !== 'user') notify(m);
    soon();
  });
  es.addEventListener('message_update', (e) => {
    const m = JSON.parse(e.data);
    const i = S.messages.findIndex((x) => x.id === m.id);
    if (i < 0) return;
    S.messages[i] = m;
    const el = document.querySelector(`[data-mid="${m.id}"]`);
    if (el) {
      const th = $('#thread');
      const nearBottom = th.scrollHeight - th.scrollTop - th.clientHeight < 200;
      el.outerHTML = renderMessage(m, S.messages[i - 1]);
      if (nearBottom) th.scrollTop = th.scrollHeight;
    }
  });
  let pending;
  const soon = () => { clearTimeout(pending); pending = setTimeout(async () => { await refreshState(); if (S.current) updateHeaderBits(); }, 150); };
  for (const ev of ['bot_status', 'state_changed', 'approvals_changed']) es.addEventListener(ev, soon);
  es.onerror = () => { connectionStatus(navigator.onLine?'Reconnecting…':'Offline — instructions stay on this device');fetch('/api/state').then((r) => { if (r.status === 401) location.href = '/login'; }).catch(() => {}); };
  es.onopen = () => { connectionStatus('Live · connected');refreshState(); if (S.current) openThread(threadKey()); };
}
window.addEventListener('offline',()=>connectionStatus('Offline — instructions stay on this device'));
window.addEventListener('online',()=>{connectionStatus('Reconnecting…');connect();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&navigator.onLine){connectionStatus('Reconnecting…');connect();}});
function updateHeaderBits() {
  const b = S.current?.type === 'bot' ? bot(S.current.id) : null;
  const st = $('.head .status');
  if (b) {
    const html = b.status.state !== 'idle' ? `<span class="status ${b.status.state}">${esc(b.status.label)}</span>` : '';
    if (st) st.outerHTML = html; else if (html) $('.head .title')?.insertAdjacentHTML('beforeend', html);
  }
  const bell = $('.head [data-act="panel"]');
  if (bell) bell.innerHTML = ICON.bell + (S.data.approvals.length ? `<i class="count hot">${S.data.approvals.length}</i>` : '');
}
setInterval(() => { // tick live timers and rotate phrases in place, so animations don't restart
  document.querySelectorAll('details.trace.live').forEach((el) => {
    const started = Number(el.dataset.started);
    const dur = $('[data-dur]', el);
    if (dur) dur.textContent = fmtDur(Math.round(elapsedMs(started) / 1000));
    const ph = $('[data-phrase]', el), next = workPhrase(started);
    if (ph && ph.textContent !== next) {
      ph.classList.add('out');
      setTimeout(() => { ph.textContent = next; ph.classList.remove('out'); }, 250);
    }
  });
}, 1000);

function notify(m) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  const a = JSON.parse(m.body);
  const n = new Notification(`${bot(m.author)?.name || 'A bot'} needs approval`, { body: describeTool(a.tool, a.input), icon: '/icon.svg', tag: 'approval-' + a.approvalId });
  n.onclick = () => { window.focus(); openThread(m.thread); };
}

// ---------- popover menus ----------
function popover(anchor, items) {
  closePopover();
  const r = anchor.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'popover';
  el.innerHTML = items.map(([act, label, icon]) => `<button data-act="${act}">${icon || ''}<span>${label}</span></button>`).join('');
  document.body.append(el);
  const below = r.bottom + el.offsetHeight + 8 < innerHeight;
  el.style.top = (below ? r.bottom + 6 : r.top - el.offsetHeight - 6) + 'px';
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + 'px';
}
function closePopover() { document.querySelector('.popover')?.remove(); }

// ---------- modals ----------
function modal(html, { wide = false, cls = '', sticky = false } = {}) {
  closePopover();
  const root = $('#modal-root');
  root.innerHTML = `<div class="scrim"><div class="modal ${wide ? 'wide' : ''} ${sticky ? 'sticky' : ''} ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  const scrim = $('.scrim', root);
  if (!sticky) scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeModal(); });
  setTimeout(() => $('input:not([type=checkbox]):not([type=color]), textarea', root)?.focus(), 30);
  return $('.modal', root);
}
// Plays the close animation, unless another modal replaced this one meanwhile.
function closeModal() {
  const root = $('#modal-root'), scrim = $('.scrim', root);
  if (!scrim || scrim.classList.contains('closing')) return;
  scrim.classList.add('closing');
  setTimeout(() => { if (root.contains(scrim)) root.innerHTML = ''; }, 160);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('.modal.sticky')) closeModal(); closePopover(); } });

function botModal(b) {
  const isNew = !b;
  const toolOptions=S.data.toolCatalog||['shell','exec_command','write_stdin','apply_patch','read_file','write_file','list_files','view_image','skills','update_plan','request_user_input','capabilities','browser','shared_note','ask_worker','self_update'].map(name=>({name,description:''}));
  b = b || { name: '', role: '', instructions: '', color: BOT_COLORS[S.data.bots.length % BOT_COLORS.length], shape: 'none/none', effort: 'medium', model: 'auto', default_model:'',
    approval_rules: ['shell(git push*)', 'shell(*Remove-Item*)', 'shell(*gh pr merge*)', 'mcp__*send*', 'mcp__*delete*', 'mcp__*pay*', 'mcp__*create_event*','automation_schedule(enable)'], allow_rules: [] };
  const fixedRoot=b.template==='orchestrator';
  let color = b.color;
  const look = outfit(b);
  const el = modal(`
    <div class="modal-head"><h2>${isNew ? 'New bot' : 'Bot settings'}</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <div class="bot-look"><div id="f-preview"></div>
      <div class="look-pick">
        <div class="swatches">${BOT_COLORS.map((c) => `<button type="button" class="swatch" data-color="${c}" style="background:${c}" aria-pressed="${c === color}" aria-label="Color ${c}"></button>`).join('')}
          <label class="swatch custom" title="Pick any color" aria-pressed="${!BOT_COLORS.includes(color)}" style="${BOT_COLORS.includes(color) ? '' : `background:${esc(color)}`}"><input type="color" id="f-color" value="${esc(/^#[0-9a-f]{6}$/i.test(color) ? color : '#c9c2f0')}" aria-label="Custom color"></label>
          <button type="button" class="btn small" data-random title="Random look">🎲 Surprise me</button></div>
        <div class="look-tabs" role="tablist">${LOOK_PARTS.map(([k, , label], i) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${i === 0}">${label}</button>`).join('')}</div>
        <div class="shapes" id="f-picks"></div>
      </div></div>
    <label class="field">Name<input id="f-name" value="${esc(b.name)}" placeholder="e.g. Inbox Manager"></label>
    <label class="field">Role (one line)<input id="f-role" value="${esc(b.role)}" placeholder="Gets my inbox to zero and drafts replies"></label>
    ${fixedRoot?`<div class="field">Sidebar position<input type="hidden" id="f-display-group" value="${esc(displayGroup(b))}"><span class="hint">The root Orchestrator stays first, above the display groups. Its position is fixed and its chat is separate from the team disclosure.</span></div>`:`<label class="field">Display group<select id="f-display-group">${DISPLAY_GROUPS.map(group=>`<option value="${esc(group.id)}" ${displayGroup(b)===group.id?'selected':''}>${esc(group.label)}</option>`).join('')}</select><span class="hint">Organizes the sidebar only. Agent communication, delegation, permissions and the parent agent stay unchanged.</span></label>`}
    <label class="field">Parent agent<select id="f-parent" ${fixedRoot?'disabled':''}><option value="">Independent agent</option>${S.data.bots.filter(p=>p.id!==b.id).map(p=>`<option value="${p.id}" ${Number(b.parent_bot_id)===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select><span class="hint">${fixedRoot?'The root Orchestrator has no parent. Root setup manages this relationship.':'Register this worker as a subagent. Delegated tasks have their own checkpoints and results; cycles are blocked.'}</span></label>
    <label class="field">Specialist instructions<textarea id="f-instr" rows="10" placeholder="What this bot is for, how it should work, what tools or folders to use…">${esc(b.instructions)}</textarea><span class="hint">Combined with Nimbus’s shared system instructions for evidence, Windows tools, browser ownership, handoffs, recovery and truthful completion.</span></label>
    <div class="two">
      <label class="field">Effort<select id="f-effort">${EFFORTS.map(([v, l]) => `<option value="${v}" ${b.effort === v ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="hint">Lower effort uses less of your plan.</span></label>
      <label class="field">Role model preference<select id="f-default-model">${[['','No preference'],['local','Shared local model'],['luna','Luna'],['terra','Terra'],['sol','Sol'],['astra','Astra']].map(([v,n])=>`<option value="${v}" ${(b.default_model||'')===v?'selected':''}>${n}</option>`).join('')}</select><span class="hint">The local router uses this starting point and chooses the model suited to each task.</span></label>
    </div>
    <label class="field">Model override<select id="f-model">${[['auto','Automatic — use role preference and task needs'],['local','Use shared local model'],['luna','Use Luna'],['terra','Use Terra'],['sol','Use Sol'],['astra','Use Astra']].map(([v,n])=>`<option value="${v}" ${(b.model||'auto')===v?'selected':''}>${n}</option>`).join('')}</select><span class="hint">An explicit choice overrides automatic routing. Local and OpenAI outages can fall back to the other backend. Workers share local capacity.</span></label>
    <details class="adv"><summary>Worker tools · ${toolOptions.length} available</summary><label class="field">Find a tool<input data-tool-filter placeholder="Search names and descriptions"></label><div class="tool-picks specialist-picks">${toolOptions.map(tool=>`<label data-tool-option data-search="${esc((tool.name+' '+tool.description).toLowerCase())}" title="${esc(tool.description)}"><input type="checkbox" data-worker-tool="${esc(tool.name)}" ${(!b.tools||JSON.parse(b.tools).includes(tool.name))?'checked':''}><span><b>${esc(tool.name.replaceAll('_',' '))}</b><small>${esc(tool.description)}</small></span></label>`).join('')}</div><p class="hint">Each specialist receives tools for its role. Connector tools are configured in Plugins. Tool descriptions report supported workflows and limits.</p></details>
    <details class="adv"><summary>Approval rules</summary>
      <label class="field">Ask me before (one rule per line)<textarea id="f-rules" class="code" rows="5">${esc(b.approval_rules.join('\n'))}</textarea>
        <span class="hint">Tool names with * wildcards. shell(pattern) matches commands, e.g. shell(git push*). Plugin tools start with mcp__.</span></label>
      <label class="field">Always allow (overrides the list above)<textarea id="f-allow" class="code" rows="2">${esc(b.allow_rules.join('\n'))}</textarea>
        <span class="hint">Allow rules override matching approval rules for this worker.</span></label>
    </details>
    <div class="modal-foot">
      ${isNew ? '' : '<button class="btn danger left" id="f-del">Delete bot</button>'}
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="f-save">${isNew ? 'Create bot' : 'Save'}</button>
    </div>`, { wide: true });
  const botFormValue=()=>{
    const lines=id=>$(id,el).value.split('\n').map(value=>value.trim()).filter(Boolean),selected=[...el.querySelectorAll('[data-worker-tool]:checked')].map(input=>input.dataset.workerTool),selectedSet=new Set(selected),advertised=new Set(toolOptions.map(tool=>tool.name)),existing=b.tools?JSON.parse(b.tools):[];
    const tools=[...existing.filter(name=>!advertised.has(name)||selectedSet.has(name)),...selected.filter(name=>!existing.includes(name))];
    return {name:$('#f-name',el).value.trim(),role:$('#f-role',el).value.trim(),instructions:$('#f-instr',el).value,color,shape:lookShape(look),display_group:$('#f-display-group',el).value,parent_bot_id:$('#f-parent',el).value?Number($('#f-parent',el).value):null,effort:$('#f-effort',el).value,default_model:$('#f-default-model',el).value,tools,model:$('#f-model',el).value.trim(),approval_rules:lines('#f-rules'),allow_rules:lines('#f-allow')};
  };
  // Compare editor values with their opening values, not stale server fields.
  // A display-only change must not resend or reorder runtime configuration.
  const initialBotForm=botFormValue();
  const preview = () => { $('#f-preview', el).innerHTML = avatar({ color, shape: lookShape(look) }, 84); };
  let tab = 'body';
  const setColor = (c) => {
    color = c;
    el.querySelectorAll('[data-color]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.color === c));
    const cu = $('.swatch.custom', el); cu.setAttribute('aria-pressed', !BOT_COLORS.includes(c)); cu.style.background = BOT_COLORS.includes(c) ? '' : c;
    preview(); drawPicks();
  };
  // One row of choices for the selected tab; each shows the critter in the current color with that item.
  const drawPicks = () => {
    const [key, list] = LOOK_PARTS.find(([k]) => k === tab);
    $('#f-picks', el).innerHTML = list.map((v) => `<button type="button" class="shape" data-part="${key}" data-val="${v}" aria-pressed="${look[key] === v}" title="${v}" aria-label="${key}: ${v}">
      <svg viewBox="0 0 14 14" width="30" height="30" shape-rendering="crispEdges">${critter(color, { ...look, [key]: v })}</svg></button>`).join('');
  };
  preview();
  el.addEventListener('input', (e) => { if (e.target.id === 'f-color') setColor(e.target.value); });
  el.addEventListener('click', async (e) => {
    const sw = e.target.closest('[data-color]');
    if (sw) setColor(sw.dataset.color);
    const tb = e.target.closest('[data-tab]');
    if (tb) { tab = tb.dataset.tab; el.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x === tb)); drawPicks(); }
    const pb = e.target.closest('[data-part]');
    if (pb) { look[pb.dataset.part] = pb.dataset.val; preview(); drawPicks(); }
    if (e.target.closest('[data-random]')) {
      const any = (l) => l[Math.floor(Math.random() * l.length)];
      // Accessories are optional, so "none" comes up often enough to keep random bots readable.
      for (const [k, list] of LOOK_PARTS) look[k] = ['hat', 'glasses', 'extra'].includes(k) && Math.random() < 0.35 ? list[0] : any(list);
      setColor(any(BOT_COLORS));
    }
    if (e.target.closest('[data-close]')) closeModal();
    if (e.target.id === 'f-del' && confirm(`Delete ${b.name}? Its chat history stays in the database, but the bot is gone.`)) {
      await api(`/api/bots/${b.id}`, { method: 'DELETE' }); closeModal(); S.current = null; history.replaceState(null, '', '#'); await refreshState(); renderMain();
    }
    if (e.target.id === 'f-save') {
      const values=botFormValue(),payload=isNew?values:Object.fromEntries(Object.entries(values).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(initialBotForm[key])));
      if (!values.name) return toast('Give the bot a name');
      try {
        const saved=isNew?await api('/api/bots',{method:'POST',body:payload}):Object.keys(payload).length?await api(`/api/bots/${b.id}`,{method:'PATCH',body:payload}):b;
        closeModal(); await refreshState(); openThread('bot:' + saved.id);
      } catch (err) { toast(err.message); }
    }
  });
  drawPicks();
  el.querySelector('[data-tool-filter]')?.addEventListener('input',event=>{
    const query=event.target.value.trim().toLowerCase();for(const label of el.querySelectorAll('[data-tool-option]'))label.hidden=!label.dataset.search.includes(query);
  });
}

function roomModal(r) {
  const isNew = !r;
  r = r || { name: '', goal: '', members: [], lead_bot_id: null, bots_can_talk: 1 };
  if (isNew && !S.data.bots.length) return toast('Add a bot first');
  const members = new Set(r.members);
  let lead = r.lead_bot_id;
  const el = modal(`
    <div class="modal-head"><h2>${isNew ? 'New group chat' : 'Group chat settings'}</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <label class="field">Name<input id="r-name" value="${esc(r.name)}" placeholder="Offsite crew"></label>
    <label class="field">Goal (bots see this)<textarea id="r-goal" rows="2" placeholder="Plan the team offsite for March.">${esc(r.goal)}</textarea></label>
    <div class="field">Bots<div id="r-picks" class="picks"></div></div>
    <label class="check"><input type="checkbox" id="r-talk" ${r.bots_can_talk ? 'checked' : ''}> Bots can @mention each other to hand off work</label>
    <div class="modal-foot">
      ${isNew ? '' : '<button class="btn danger left" id="r-del">Delete chat</button>'}
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="r-save">${isNew ? 'Create chat' : 'Save'}</button>
    </div>`);
  const drawPicks = () => {
    $('#r-picks', el).innerHTML = S.data.bots.map((b) => {
      const on = members.has(b.id);
      return `<label class="pick ${on ? 'on' : ''}">
        <input type="checkbox" data-member="${b.id}" ${on ? 'checked' : ''}>${avatar(b, 28)}<span>${esc(b.name)}</span>
        ${on ? `<span class="lead"><input type="radio" name="lead" data-lead="${b.id}" ${lead === b.id ? 'checked' : ''}> Lead</span>` : ''}
      </label>`;
    }).join('');
  };
  drawPicks();
  el.addEventListener('change', (e) => {
    if (e.target.dataset.member) {
      const id = Number(e.target.dataset.member);
      e.target.checked ? members.add(id) : members.delete(id);
      if (!members.has(lead)) lead = [...members][0] ?? null;
      drawPicks();
    }
    if (e.target.dataset.lead) lead = Number(e.target.dataset.lead);
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) closeModal();
    if (e.target.id === 'r-del' && confirm(`Delete ${r.name}?`)) {
      await api(`/api/rooms/${r.id}`, { method: 'DELETE' }); closeModal(); S.current = null; await refreshState(); renderMain();
    }
    if (e.target.id === 'r-save') {
      const payload = { name: $('#r-name', el).value.trim(), goal: $('#r-goal', el).value.trim(), members: [...members], lead_bot_id: lead, bots_can_talk: $('#r-talk', el).checked };
      if (!payload.name) return toast('Give the chat a name');
      if (!payload.members.length) return toast('Pick at least one bot');
      const saved = isNew ? await api('/api/rooms', { method: 'POST', body: payload }) : await api(`/api/rooms/${r.id}`, { method: 'PATCH', body: payload });
      closeModal(); await refreshState(); openThread('room:' + saved.id);
    }
  });
}

const PRESETS = [['Every morning, 9am', '0 9 * * *'], ['Weekdays, 8am', '0 8 * * 1-5'], ['Every 2 hours', '0 */2 * * *'], ['Every hour', '0 * * * *'], ['Mondays, 9am', '0 9 * * 1'], ['Every evening, 6pm', '0 18 * * *']];
function routinesModal(b) {
  const el = modal(`<div class="modal-head"><h2>Routines</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <p class="muted">Things ${esc(b.name)} does on a schedule, even when the app is closed.</p>
    <div id="rt-list" class="stack-list"></div>
    <div class="panel">
      <label class="field">What should it do?<textarea id="rt-prompt" rows="2" placeholder="Triage my inbox and draft replies to clients."></textarea></label>
      <label class="field">When (cron: minute hour day month weekday)<input id="rt-cron" class="code" value="0 9 * * *"></label>
      <label class="toggle-row"><span class="m-text"><b>Quiet check</b><span>Only tell me if something needs attention. When all is fine it leaves a small “✓ All clear” line, with no notification.</span></span>
        <input type="checkbox" class="switch" id="rt-quiet"></label>
      <div class="chips">${PRESETS.map(([l, c]) => `<button type="button" class="chip" data-cron="${c}">${l}</button>`).join('')}</div>
      <div class="modal-foot"><button class="btn primary" id="rt-add">Add routine</button></div>
    </div>`, { wide: true });
  const draw = () => {
    const list = S.data.routines.filter((r) => r.bot_id === b.id);
    $('#rt-list', el).innerHTML = list.length ? list.map((r) => `
      <div class="panel">
        <div class="top"><code>${esc(r.cron)}</code>${r.quiet ? '<span class="chip">Quiet</span>' : ''}${r.enabled ? '' : '<span class="muted">Paused</span>'}
          <span class="grow"></span>
          <button class="btn small" data-run="${r.id}">Run now</button>
          <button class="btn small" data-toggle="${r.id}" data-en="${r.enabled}">${r.enabled ? 'Pause' : 'Resume'}</button>
          <button class="btn small danger" data-delr="${r.id}">Delete</button>
        </div>
        <div>${esc(r.prompt)}</div>
      </div>`).join('') : '<div class="muted">No routines yet.</div>';
  };
  draw();
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.close !== undefined) return closeModal();
    if (t.dataset.cron) $('#rt-cron', el).value = t.dataset.cron;
    try {
      if (t.id === 'rt-add') {
        const prompt = $('#rt-prompt', el).value.trim();
        if (!prompt) return toast('Say what the routine should do');
        await api('/api/routines', { method: 'POST', body: { bot_id: b.id, cron: $('#rt-cron', el).value, prompt, quiet: $('#rt-quiet', el).checked } });
        $('#rt-prompt', el).value = '';
      }
      if (t.dataset.run) { await api(`/api/routines/${t.dataset.run}/run`, { method: 'POST' }); toast('Started'); closeModal(); return; }
      if (t.dataset.toggle) await api(`/api/routines/${t.dataset.toggle}`, { method: 'PATCH', body: { enabled: t.dataset.en === '1' ? 0 : 1 } });
      if (t.dataset.delr) await api(`/api/routines/${t.dataset.delr}`, { method: 'DELETE' });
      await refreshState(); draw(); renderMain();
    } catch (err) { toast(err.message); }
  });
}

async function memoryModal(b) {
  const { text } = await api(`/api/bots/${b.id}/memory`);
  const el = modal(`<div class="modal-head"><h2>Memory</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <p class="muted">What ${esc(b.name)} has learned. It adds to this itself when you tell it a rule; edit freely.</p>
    <label class="field"><textarea id="mem" class="code" rows="14">${esc(text)}</textarea></label>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="mem-save">Save</button></div>`, { wide: true });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) closeModal();
    if (e.target.id === 'mem-save') { await api(`/api/bots/${b.id}/memory`, { method: 'PUT', body: { text: $('#mem', el).value } }); closeModal(); toast('Memory saved'); }
  });
}

// ---------- marketplace ----------
function pluginIcon(p, size = 40) {
  return `<span class="p-icon" style="width:${size}px;height:${size}px;background:${esc(p.color)};font-size:${Math.round(size * (p.icon.length > 1 ? 0.34 : 0.46))}px">${esc(p.icon)}</span>`;
}
async function marketModal(focus = '') {
  const el = modal(`<div class="market-top">
      <label class="search big">${ICON.search}<input id="mk-q" placeholder="Search plugins and bots" autocomplete="off"></label>
      <button class="icon-btn" data-close aria-label="Close">${ICON.close}</button>
    </div><div class="market-body" id="mk-body"><div class="muted">Loading…</div></div>`, { wide: true, cls: 'market' });
  S.market = await api('/api/marketplace');
  let query = '';
  const row = (p, kind) => {
    const isBot = kind === 'bot';
    const btn = isBot ? `<button class="btn pill" data-add-bot="${p.id}">${p.added ? 'Add again' : 'Add'}</button>`
      : p.kind === 'builtin' ? `<button class="btn pill ${p.installed ? 'ghost' : ''}" data-connect="${p.id}">${p.installed ? 'Connected' : 'Connect'}</button>`
      : p.installed ? `<button class="btn pill ghost" data-manage="${p.id}">Installed</button>`
      : `<button class="btn pill" data-install="${p.id}">Add</button>`;
    return `<div class="m-row">${isBot ? avatar(p, 40) : pluginIcon(p)}
      <div class="m-text"><b>${esc(p.name)}</b><span>${esc(isBot ? p.role : p.desc)}</span>${isBot?`<small class="muted">Prefers ${esc(p.default_model==='local'?'shared local':(p.default_model||'automatic'))} · ${esc(p.effort)} effort · editable</small>`:''}</div>${btn}</div>`;
  };
  const section = (title, list, kind) => list.length ? `<section><h3>${title}</h3><div class="m-grid">${list.map((p) => row(p, kind)).join('')}</div></section>` : '';
  const draw = () => {
    const match = (p) => !query || `${p.name} ${p.role || ''} ${p.desc || ''} ${p.category}`.toLowerCase().includes(query);
    const T = S.market.templates.filter(match), P = S.market.plugins.filter(match);
    const cats = (list) => [...new Set(list.map((x) => x.category))];
    $('#mk-body', el).innerHTML = cats(T).map((c) => section(`${c} Bots`, T.filter((t) => t.category === c), 'bot')).join('')
      + section('Featured Plugins', P.filter((p) => p.category === 'Featured'), 'plugin')
      + cats(P).filter((c) => c !== 'Featured').map((c) => section(c, P.filter((p) => p.category === c), 'plugin')).join('')
      + (!T.length && !P.length ? '<div class="empty small">Nothing matches that search.</div>' : '');
    if (focus === 'plugins' && !query) { $('#mk-body', el).querySelector('section:nth-of-type(n+2) h3')?.closest('section'); const s = [...el.querySelectorAll('h3')].find((h) => h.textContent === 'Featured Plugins'); s?.scrollIntoView(); focus = ''; }
  };
  draw();
  $('#mk-q', el).addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); draw(); });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.close !== undefined) return closeModal();
    try {
      if (t.dataset.addBot) {
        const saved = await api(`/api/templates/${t.dataset.addBot}/add`, { method: 'POST' });
        closeModal(); await refreshState(); await openThread('bot:' + saved.id);
        toast(`${saved.name} joined your team`);
      }
      if (t.dataset.connect) return connectModal(S.market.plugins.find((p) => p.id === t.dataset.connect));
      if (t.dataset.install) return installModal(S.market.plugins.find((p) => p.id === t.dataset.install));
      if (t.dataset.manage) return installModal(S.market.plugins.find((p) => p.id === t.dataset.manage));
    } catch (err) { toast(err.message); }
  });
}

function connectModal(p) {
  const el=modal(`<div class="modal-head"><h2>${esc(p.name)}</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div><p>${esc(p.desc)}</p><p>Browser groups are built into Nimbus. Enable the browser tool in a worker’s settings to give it its own tabs and sign-ins.</p>`);
  el.addEventListener('click',e=>{if(e.target.closest('[data-close]'))closeModal();});
}

function installModal(p) {
  const el = modal(`<div class="modal-head"><div class="ph">${pluginIcon(p, 44)}<h2>${esc(p.name)}</h2></div><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <p>${esc(p.desc)}</p>
    ${p.fields.length ? p.fields.map((f) => `<label class="field">${esc(f.label)}<input type="password" data-key="${esc(f.key)}" autocomplete="off" placeholder="${p.installed ? 'Saved · paste to replace' : ''}">${f.help ? `<span class="hint">Get one at ${esc(f.help)}</span>` : ''}</label>`).join('')
      : '<p class="muted">No setup needed.</p>'}
    <p class="muted">Credentials are protected for this Windows account. After configuring, enable the connector for the workers that need it.</p>
    <div class="modal-foot">
      ${p.installed ? '<button class="btn danger left" data-remove>Remove</button>' : ''}
      <button class="btn" data-back>Back</button>
      <button class="btn primary" data-save>${p.installed ? (p.fields.length ? 'Update' : 'Done') : 'Install'}</button>
    </div>`);
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return closeModal();
    if (e.target.closest('[data-back]')) return marketModal();
    try {
      if (e.target.closest('[data-remove]')) {
        if (!confirm(`Remove ${p.name}? Bots using it lose access.`)) return;
        await api(`/api/plugins/${p.id}`, { method: 'DELETE' }); toast(`${p.name} removed`); return marketModal();
      }
      if (e.target.closest('[data-save]')) {
        if (p.installed && !p.fields.length) return marketModal();
        const secrets = {};
        el.querySelectorAll('[data-key]').forEach((i) => { secrets[i.dataset.key] = i.value; });
        await api(`/api/plugins/${p.id}`, { method: 'POST', body: { secrets } });
        toast(`${p.name} installed`);
        const cur = S.current?.type === 'bot' ? bot(S.current.id) : null;
        if (cur) { await api(`/api/bots/${cur.id}/plugins`, { method: 'PUT', body: { plugins: [...new Set([...cur.plugins, p.id])] } }); toast(`${p.name} is on for ${cur.name}`); }
        closeModal(); refreshState();
      }
    } catch (err) { toast(err.message); }
  });
}

async function botPluginsModal(b) {
  const market=await api('/api/marketplace'),on=new Set(b.plugins||[]),usable=market.plugins.filter(p=>p.installed&&p.kind==='mcp');
  const el=modal(`<div class="modal-head"><h2>${esc(b.name)}’s connectors</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div><p>These Nimbus connectors are available to the worker on local and OpenAI model routes. Credentials are configured independently.</p><div class="stack-list">${usable.map(p=>`<label class="toggle-row">${pluginIcon(p,34)}<span class="m-text"><b>${esc(p.name)}</b><span>${esc(p.desc)}</span></span><input type="checkbox" class="switch" data-plugin="${p.id}" ${on.has(p.id)?'checked':''}></label>`).join('')||'<p class="muted">No connectors configured yet. Add one from the Marketplace.</p>'}</div><div class="modal-foot"><button class="btn left" data-browse>Browse connectors</button><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Save</button></div>`,{wide:true});
  el.addEventListener('click',async e=>{if(e.target.closest('[data-close]'))closeModal();if(e.target.closest('[data-browse]'))marketModal('plugins');if(e.target.closest('[data-save]')){try{await api(`/api/bots/${b.id}/plugins`,{method:'PUT',body:{plugins:[...el.querySelectorAll('[data-plugin]:checked')].map(i=>i.dataset.plugin)}});closeModal();await refreshState();toast('Connectors saved for the next task');}catch(err){toast(err.message);}}});
}

function appearanceModal() {
  const p = getPrefs();
  const ACCENTS = ['#3b82f6', '#7c5cf5', '#e84fa0', '#e2475f', '#f08a3c', '#f5c542', '#1f9d6b', '#3fb6a8', '#22d3ee'];
  const save = () => { const { mode, ...rest } = p; try { localStorage.setItem('nimbus.appearance', JSON.stringify(rest)); } catch {} applyTheme(); draw(); };
  const el = modal('<div id="ap"></div>', { wide: true });
  // A theme card is a tiny mock of the app in that theme's colors.
  const card = (id, th, attr) => { const v = th.vars || {}; const bg = v.bg || (th.scheme === 'dark' ? '#0e0e0f' : '#ffffff'), side = v.side || (th.scheme === 'dark' ? '#161617' : '#f6f6f7'),
      bub = v.bubble || (th.scheme === 'dark' ? '#232326' : '#f0f0f2'), user = v.user || (th.scheme === 'dark' ? '#e9e9ec' : '#151517'), text = v.text || (th.scheme === 'dark' ? '#ececee' : '#151517');
    return `<button class="theme-card" ${attr}="${id}" aria-pressed="${(attr === 'data-theme-pick' ? p.theme : attr === 'data-dark-pick' ? (p.darkTheme || 'dark') : (p.lightTheme || 'light')) === id}">
      <span class="tc-mock" style="background:${bg}"><i style="background:${side}"></i><b style="background:${bub}"></b><b style="background:${user};margin-left:auto"></b><u style="background:${th.accent}"></u></span>
      <span class="tc-name" style="color:inherit">${esc(th.name)}</span></button>`; };
  const list = (filter, attr) => Object.entries(THEMES).filter(([, th]) => !filter || th.scheme === filter).map(([id, th]) => card(id, th, attr)).join('');
  const draw = () => {
    $('#ap', el).innerHTML = `<div class="stack-list" style="gap:18px">
      <div class="modal-head"><h2>Appearance</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
      <label class="toggle-row"><span class="m-text"><b>Match my device</b><span>Switch between a dark and a light theme with your device’s setting.</span></span>
        <input type="checkbox" class="switch" id="ap-system" ${p.theme === 'system' ? 'checked' : ''}></label>
      ${p.theme === 'system'
        ? `<div class="field">Dark theme<div class="theme-grid">${list('dark', 'data-dark-pick')}</div></div>
           <div class="field">Light theme<div class="theme-grid">${list('light', 'data-light-pick')}</div></div>`
        : `<div class="field">Theme<div class="theme-grid">${list(null, 'data-theme-pick')}</div></div>`}
      <div class="field">Accent<div class="swatches">
        <button class="btn small ${p.accent ? '' : 'primary'}" data-accent="">Theme’s own</button>
        ${ACCENTS.map((c) => `<button class="swatch" data-accent="${c}" style="background:${c}" aria-pressed="${p.accent === c}" aria-label="Accent ${c}"></button>`).join('')}
        <label class="swatch custom" title="Any color" aria-pressed="${!!p.accent && !ACCENTS.includes(p.accent)}"><input type="color" id="ap-accent" value="${esc(p.accent || '#3b82f6')}" aria-label="Custom accent"></label></div></div>
      <div class="modal-foot"><button class="btn primary" data-close>Done</button></div></div>`;
  };
  draw();
  el.addEventListener('change', (e) => {
    if (e.target.id === 'ap-system') { p.theme = e.target.checked ? 'system' : (resolveThemeId(p) || 'dark'); save(); }
  });
  el.addEventListener('input', (e) => { if (e.target.id === 'ap-accent') { p.accent = e.target.value; const { mode, ...rest } = p; try { localStorage.setItem('nimbus.appearance', JSON.stringify(rest)); } catch {} applyTheme(); } });
  el.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.close !== undefined) return closeModal();
    if (t.dataset.themePick) p.theme = t.dataset.themePick;
    else if (t.dataset.darkPick) p.darkTheme = t.dataset.darkPick;
    else if (t.dataset.lightPick) p.lightTheme = t.dataset.lightPick;
    else if (t.dataset.accent !== undefined) p.accent = t.dataset.accent || null;
    else return;
    save();
  });
  // Turning "match my device" off keeps whichever theme is showing right now.
  function resolveThemeId(pr) {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    return dark ? (pr.darkTheme || 'dark') : (pr.lightTheme || 'light');
  }
}

// ---------- activity log ----------
// Everything bots did lately: each run (who asked, how long, outcome) and each approval decision.
async function activityLogModal() {
  const el = modal(`<div class="modal-head"><h2>Activity log</h2>
      <div class="seg"><button data-days="1" aria-pressed="false">Today</button><button data-days="7" aria-pressed="true">7 days</button><button data-days="30" aria-pressed="false">30 days</button></div>
      <button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div><div id="log-body" class="muted">Loading…</div>`, { wide: true });
  const load = async (days) => {
    const { runs, approvals } = await api('/api/activity?days=' + days);
    const byRun = {};
    for (const a of approvals) (byRun[a.run_id] ||= []).push(a);
    const src = (r) => r.parent_run ? 'from another bot' : r.thread.startsWith('room:') ? 'group chat' : /^\(Scheduled/.test(r.prompt) ? 'routine' : 'you';
    const icon = { done: '✓', error: '✗', stopped: '■', interrupted: '⚠', running: '…', queued: '…' };
    $('#log-body', el).innerHTML = runs.length ? `<div class="log">${runs.map((r) => {
      const b = bot(r.bot_id), secs = r.ended_at && r.started_at ? r.ended_at - r.started_at : null;
      return `<div class="log-row ${r.status}"><span class="li">${icon[r.status] || '·'}</span>${avatar(b, 22)}
        <div class="lt"><div><b>${esc(b?.name || 'Deleted bot')}</b> <span class="muted">${esc(src(r))} · ${stamp(r.started_at)}${secs != null ? ` · ${secs >= 60 ? Math.round(secs / 60) + ' min' : secs + 's'}` : ''} · ${esc(r.status)}</span></div>
        <div class="lp">${esc(r.prompt.replace(/^\(Scheduled[^)]*\)\s*/, ''))}</div>
        ${(byRun[r.id] || []).map((a) => `<div class="la ${a.status}">${ICON.lock} ${esc(describeTool(a.tool, (() => { try { return JSON.parse(a.input); } catch { return {}; } })()))} — <b>${esc(a.status)}</b>${a.note ? ` · “${esc(a.note)}”` : ''}</div>`).join('')}</div>
        <button class="btn small" data-open="${esc(r.thread)}">Open</button></div>`; }).join('')}</div>` : '<p class="muted">Nothing in this period.</p>';
  };
  load(7).catch((e) => { $('#log-body', el).textContent = e.message; });
  el.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.close !== undefined) return closeModal();
    if (t.dataset.days) { el.querySelectorAll('[data-days]').forEach((x) => x.setAttribute('aria-pressed', x === t)); load(Number(t.dataset.days)); }
    if (t.dataset.open) { closeModal(); openThread(t.dataset.open); }
  });
}

// ---------- server settings ----------
async function serverModal() { return runtimeUI.settings(); }
async function computerModal(b) { return runtimeUI.group(b.id); }

async function passkeysModal() {
  const el = modal(`<div class="modal-head"><h2>Passkeys</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <div data-passkey-body><p class="muted">Loading passkeys…</p></div>
    <p data-passkey-status role="alert" hidden></p><a href="/login" data-passkey-signin hidden>Sign in again</a>
    <div class="modal-foot"><button class="btn" data-close>Close</button></div>`);
  let state = null, busy = false;
  const body = $('[data-passkey-body]', el), status = $('[data-passkey-status]', el), signIn = $('[data-passkey-signin]', el);
  const date = (value, fallback) => {
    if (value == null || value === '') return fallback;
    const number = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : null;
    const parsed = new Date(number == null ? value : number < 1e12 ? number * 1000 : number);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed.toLocaleString();
  };
  function showMessage(message, error = false) {
    status.textContent = message; status.hidden = !message;
    status.className = error ? 'runtime-warning' : 'muted';
  }
  function setBusy(value) {
    busy = value; el.setAttribute('aria-busy', String(value));
    const wrongOrigin = canonicalPasskeyOrigin(state?.origin) !== location.origin;
    for (const field of body.querySelectorAll('input')) field.disabled = value;
    for (const button of body.querySelectorAll('[data-passkey-add], [data-passkey-remove]')) {
      button.disabled = value || !state?.available || wrongOrigin || button.hasAttribute('data-passkey-remove') && state.passkeys.length <= 1;
    }
  }
  function render() {
    const origin = canonicalPasskeyOrigin(state.origin);
    const wrongOrigin = origin !== location.origin;
    if (!state.available) {
      body.innerHTML = '<p>Passkeys are unavailable for this sign-in method.</p>';
      return;
    }
    body.innerHTML = `<p>${state.required ? 'Your username, password and a passkey are required to sign in.' : 'Use a passkey with your Nimbus account.'}${state.username ? ` Signed in as ${esc(state.username)}.` : ''}</p>
      ${wrongOrigin ? `<p class="runtime-warning">Manage your passkeys at the Nimbus sign-in address.${origin ? ` <a href="${esc(origin)}">${esc(origin)}</a>` : ' The configured address is unavailable.'}</p>` : ''}
      <div class="stack-list">${state.passkeys.length ? state.passkeys.map(key => `<div class="panel"><div class="top"><b>${esc(key.label || 'Passkey')}</b><span class="grow"></span><button class="btn small danger" data-passkey-remove="${esc(key.id)}" ${state.passkeys.length <= 1 ? 'disabled title="Add another passkey before removing the last one"' : ''}>Remove</button></div><p class="muted">Created ${esc(date(key.createdAt, 'at an unknown time'))}<br>Last used: ${esc(date(key.lastUsedAt, 'not used yet'))}</p></div>`).join('') : '<p class="muted">No passkeys are registered.</p>'}</div>
      <p class="muted">Sign in within the last five minutes and enter your current password to add or remove a passkey. Add another passkey before removing your last one.</p>
      <label class="field">Current password<input type="password" data-passkey-password autocomplete="current-password"></label>
      <label class="field">New passkey name (optional)<input data-passkey-label maxlength="80" autocomplete="off" placeholder="For example, my phone"></label>
      <div class="modal-foot"><button class="btn primary" data-passkey-add>Add passkey</button></div>`;
    setBusy(busy);
  }
  async function load() {
    state = await passkeyRequest('/api/passkeys', { method: 'GET' });
    if (!Array.isArray(state.passkeys)) throw new Error('Nimbus returned an incomplete passkey list. Try again.');
    if (document.body.contains(el)) render();
  }
  function showError(error) {
    showMessage(passkeyError(error, { signIn: false }), true);
    signIn.hidden = error.status !== 401;
  }
  el.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-close')) return closeModal();
    if (busy || !state?.available || !button.matches('[data-passkey-add], [data-passkey-remove]')) return;
    const passwordField = $('[data-passkey-password]', el), password = passwordField?.value || '';
    if (!password) { showMessage('Enter your current password to continue.', true); passwordField?.focus(); return; }
    if (canonicalPasskeyOrigin(state.origin) !== location.origin) { showMessage('Open the Nimbus sign-in address to manage passkeys.', true); return; }
    setBusy(true); showMessage(''); signIn.hidden = true;
    try {
      if (button.hasAttribute('data-passkey-add')) {
        const label = $('[data-passkey-label]', el).value.trim();
        const enrollment = await passkeyRequest('/api/passkeys/enrollment/start', { body: { password, label } });
        passwordField.value = '';
        await performPasskey({ ticket: enrollment.ticket, registration: true, label, origin: state.origin });
        await load(); showMessage('Passkey added.');
      } else {
        if (state.passkeys.length <= 1) throw new Error('Add another passkey before removing your last one.');
        const id = button.dataset.passkeyRemove;
        if (!state.passkeys.some(key => String(key.id) === id)) throw new Error('That passkey is no longer in the list. Reopen Passkeys to refresh it.');
        await passkeyRequest(`/api/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE', body: { password } });
        await load(); showMessage('Passkey removed.');
      }
    } catch (error) { showError(error); }
    finally { if (passwordField) passwordField.value = ''; setBusy(false); }
  });
  try { await load(); } catch (error) { body.textContent = 'Passkeys could not be loaded.'; showError(error); }
}

function loadQrLib() {
  if (window.QRCode) return Promise.resolve();
  return new Promise((ok, fail) => {
    const sc = document.createElement('script');
    sc.src = '/vendor/qrcode.min.js';
    sc.onload = ok; sc.onerror = fail; document.head.append(sc);
  });
}
async function mfaModal() {
  const st = await api('/api/mfa');
  const head = `<div class="modal-head"><h2>Two-factor authentication</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>`;
  if (!st.available) {
    const el = modal(`${head}<p>You’re signed in with the shared password. Authenticator codes are for email + password accounts (set NIMBUS_ALLOWED_EMAILS).</p><div class="modal-foot"><button class="btn primary" data-close>Done</button></div>`);
    return el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  }
  if (st.enabled) {
    const el = modal(`${head}<p><span class="on-pill">On</span> Signing in with your password also asks for a code from your authenticator app.</p>
      <p class="muted">${st.recoveryLeft} of 8 recovery codes left.</p>
      <details class="adv"><summary>Turn off two-factor</summary>
        <label class="field">Password<input type="password" id="mf-pw" autocomplete="current-password"></label>
        <label class="field">Current code (or a recovery code)<input id="mf-code" inputmode="numeric" autocomplete="one-time-code"></label>
        <div class="modal-foot"><button class="btn danger" id="mf-off">Turn off</button></div>
      </details>
      <div class="modal-foot"><button class="btn primary" data-close>Done</button></div>`);
    return el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-close]')) return closeModal();
      if (e.target.id === 'mf-off') {
        try { await api('/api/mfa/disable', { method: 'POST', body: { password: $('#mf-pw', el).value, code: $('#mf-code', el).value } }); closeModal(); toast('Two-factor is off'); }
        catch (err) { toast(err.message); }
      }
    });
  }
  const setup = await api('/api/mfa/setup', { method: 'POST' });
  const el = modal(`${head}
    <p>1. Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).</p>
    <div class="qr-wrap"><div id="mf-qr"></div></div>
    <details class="adv"><summary>Can’t scan? Enter this key instead</summary><code class="secret">${esc(setup.secret.match(/.{1,4}/g).join(' '))}</code></details>
    <label class="field">2. Enter the 6-digit code the app shows<input id="mf-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456"></label>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="mf-on">Turn on</button></div>`);
  loadQrLib().then(() => new window.QRCode($('#mf-qr', el), { text: setup.uri, width: 184, height: 184, colorDark: '#000000', colorLight: '#ffffff' }))
    .catch(() => { $('#mf-qr', el).innerHTML = '<p class="muted">Couldn’t load the QR code. Use the key below instead.</p>'; el.querySelector('.adv').open = true; });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return closeModal();
    if (e.target.id !== 'mf-on') return;
    try {
      const { recovery } = await api('/api/mfa/enable', { method: 'POST', body: { code: $('#mf-code', el).value } });
      const done = modal(`<div class="modal-head"><h2>Two-factor is on</h2></div>
        <p>Save these recovery codes somewhere safe, like a password manager. Each one works once if you lose your phone. You won’t see them again.</p>
        <pre class="codes">${recovery.map(esc).join('\n')}</pre>
        <div class="modal-foot"><button class="btn" id="mf-copy">Copy</button><button class="btn primary" data-close>I saved them</button></div>`, { sticky: true });
      done.addEventListener('click', (ev) => {
        if (ev.target.id === 'mf-copy') navigator.clipboard?.writeText(recovery.join('\n')).then(() => toast('Copied'), () => toast('Copy failed; select and copy them instead'));
        if (ev.target.closest('[data-close]')) closeModal();
      });
    } catch (err) { toast(err.message); }
  });
}

function rejectModal(id) {
  const el = modal(`<div class="modal-head"><h2>Reject</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <label class="field">Tell the bot why or what to do instead (optional)<textarea id="rj" rows="3" placeholder="Don't offer a discount above 10%."></textarea></label>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="rj-go">Reject</button></div>`);
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) closeModal();
    if (e.target.id === 'rj-go') { await decide(id, 'reject', { note: $('#rj', el).value.trim() }); closeModal(); }
  });
}
async function decide(id, decision, extra = {}) {
  try { await api(`/api/approvals/${id}`, { method: 'POST', body: { decision, ...extra } }); }
  catch (e) { toast(e.message); }
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-open]');
  if (!e.target.closest('.popover') && !t?.dataset.act?.endsWith('menu')) closePopover();
  if (!t) {
    if (!e.target.closest('.side') && !e.target.closest('.aside')) { $('#side').classList.remove('open'); $('#aside').classList.remove('open'); }
    return;
  }
  if (t.closest('#modal-root')) return;
  const cur = S.current?.type === 'bot' ? bot(S.current.id) : null;
  if(t.hasAttribute('data-orchestrator-toggle')){
    if(sideQuery)return;
    sidebarPreferences();sidebarPrefs.rootCollapsed=t.getAttribute('aria-expanded')==='true';revealedOrchestratorBranch=false;saveSidebarPreferences();renderSide();document.querySelector('[data-orchestrator-toggle]')?.focus({preventScroll:true});return;
  }
  if(t.hasAttribute('data-display-group')){
    if(sideQuery)return;
    const group=t.getAttribute('data-display-group');sidebarPreferences();sidebarPrefs.collapsed[group]=t.getAttribute('aria-expanded')==='true';revealedDisplayGroups.delete(group);saveSidebarPreferences();renderSide();
    [...document.querySelectorAll('[data-display-group]')].find(button=>button.getAttribute('data-display-group')===group)?.focus({preventScroll:true});return;
  }
  if (t.dataset.open) return openThread(t.dataset.open);
  if (t.dataset.computer) { const cb = bot(t.dataset.computer); if (cb) return computerModal(cb); }
  if (t.dataset.copy) { const m = S.messages.find((x) => x.id === Number(t.dataset.copy)); await navigator.clipboard?.writeText(m?.body || '').catch(() => {}); buzz(6); return toast('Copied'); }
  if (t.dataset.edit) { const m = S.messages.find((x) => x.id === Number(t.dataset.edit)); const ta = $('#msg'); if (ta && m) { ta.value = m.body; autosize(ta); ta.focus(); } return; }
  if (t.dataset.retry) { const m = S.messages.find((x) => x.id === Number(t.dataset.retry)); if (m) await api(`/api/threads/${encodeURIComponent(threadKey())}/messages`, { method: 'POST', body: { text: m.body } }); return; }
  if (t.dataset.continue) { await api(`/api/threads/${encodeURIComponent(threadKey())}/messages`, { method: 'POST', body: { text: t.textContent === 'Try again' ? 'That failed. Please try again.' : 'Continue.' } }); return; }
  if (t.dataset.speak) return speak(t);
  if (t.dataset.hit) return openThread(t.dataset.hitThread).then(() => flashMessage(Number(t.dataset.hit)));
  if (t.dataset.approve || t.dataset.reject) buzz(12);
  if (t.dataset.approve) return decide(t.dataset.approve, 'approve', { remember: document.querySelector(`[data-remember="${t.dataset.approve}"]`)?.value || '' });
  if (t.dataset.reject) return rejectModal(t.dataset.reject);
  if (t.dataset.stop) { e.preventDefault(); return api(`/api/runs/${t.dataset.stop}/stop`, { method: 'POST' }); }
  if (t.dataset.unattach) { attachments = attachments.filter((a) => a.key !== t.dataset.unattach); return drawAttachments(); }
  const act = t.dataset.act;
  if (act) closePopover();
  switch (act) {
    case 'team': return runtimeUI.overview();
    case 'new-menu': e.stopPropagation(); return popover(t, [['new-bot', 'New bot', ICON.plus], ['new-room', 'New group chat', ICON.compose], ['market', 'Browse Marketplace', ICON.grid]]);
    case 'user-menu': e.stopPropagation(); return popover(t, [['appearance', 'Appearance', ICON.gear], ['server', 'Server settings', ICON.monitor], ['log', 'Activity log', ICON.clock], ['passkeys', 'Passkeys', ICON.lock], ['mfa', 'Two-factor authentication', ICON.lock], ['notify', 'Notifications', ICON.bell], ...(window.NimbusApp ? [['app-server', 'App: server address', ICON.gear]] : []), ['logout', 'Log out', ICON.close]]);
    case 'new-bot': return botModal();
    case 'edit-bot': return botModal(cur);
    case 'new-room': return roomModal();
    case 'edit-room': return roomModal(room(S.current.id));
    case 'routines': return routinesModal(cur);
    case 'memory': return memoryModal(cur);
    case 'plugins': return botPluginsModal(cur);
    case 'market': $('#side').classList.remove('open'); return marketModal();
    case 'appearance': return appearanceModal();
    case 'attach': return $('#file-pick').click();
    case 'dictate': return toggleDictation(t);
    case 'mfa': return mfaModal();
    case 'passkeys': return passkeysModal();
    case 'server': return serverModal();
    case 'log': return activityLogModal();
    case 'app-server': return window.NimbusApp?.changeServer();
    case 'computer': return computerModal(cur);
    case 'reset': await api(`/api/bots/${cur.id}/reset`, { method: 'POST' }); return;
    case 'side-recent': S.data.sideOrder = null; renderSide(); return api('/api/side-order', { method: 'PUT', body: { order: null } });
    case 'effort-menu': {
      e.stopPropagation(); closePopover();
      const r = t.getBoundingClientRect(), el = document.createElement('div');
      el.className = 'popover effort-pop';
      el.innerHTML = EFFORTS.map(([v, l]) => `<button data-effort="${v}" aria-pressed="${cur.effort === v}">${cur.effort === v ? ICON.check : '<i></i>'}<span>${l}</span></button>`).join('')
        + '<div class="pop-hint">Lower effort uses less of your plan.</div>';
      document.body.append(el);
      el.style.top = r.bottom + 6 + 'px';
      el.style.left = Math.max(8, Math.min(r.right - el.offsetWidth, innerWidth - el.offsetWidth - 8)) + 'px';
      el.addEventListener('click', async (ev) => {
        const o = ev.target.closest('[data-effort]'); if (!o) return;
        closePopover(); buzz(8);
        await api(`/api/bots/${cur.id}`, { method: 'PATCH', body: { effort: o.dataset.effort } });
        await refreshState(); renderMain();
        toast(`${cur.name} will use ${o.textContent.trim().toLowerCase()} effort from the next task`);
      });
      return;
    }
    case 'menu': e.stopPropagation(); {const open=$('#side').classList.toggle('open');if(open&&threadKey())revealSidebarThread(threadKey());return open;}
    case 'panel': e.stopPropagation(); $('#side').classList.remove('open'); return $('#aside').classList.toggle('open');
    case 'logout': await api('/api/logout', { method: 'POST' }); location.href = '/login'; return;
    case 'notify':
      if (!('Notification' in window)) return toast('This browser doesn’t support notifications');
      if (!window.isSecureContext) return toast('Notifications need HTTPS. See the README for how to add it.');
      return Notification.requestPermission().then((r) => toast(r === 'granted' ? 'You’ll get a notification when a bot needs approval' : 'Notifications are off'));
  }
});
document.addEventListener('change', async (e) => {
  if (e.target.id === 'file-pick') { addFiles(e.target.files); e.target.value = ''; return; }
  if (!e.target.matches('[data-effort-select]')) return;
  const cur = bot(S.current?.id);
  await api(`/api/bots/${cur.id}`, { method: 'PATCH', body: { effort: e.target.value } });
  await refreshState();
  toast(`${cur.name} will use ${e.target.selectedOptions[0].text.toLowerCase()} effort from the next task`);
});
document.addEventListener('toggle', (e) => {
  if (e.target.matches?.('details.trace')) { const id = Number(e.target.closest('[data-mid]').dataset.mid); e.target.open ? openTraces.add(id) : openTraces.delete(id); }
}, true);
document.addEventListener('input', (e) => {
  if (e.target.id === 'msg') { autosize(e.target); slashHint(e.target.value); }
  if (e.target.id === 'side-search') { sideQuery = e.target.value.trim().toLowerCase(); refreshSideOnly(); }
});
let searchSeq = 0, searchTimer;
function searchMessages() {
  clearTimeout(searchTimer);
  if (sideQuery.length < 2) return;
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    const r = await api('/api/search?q=' + encodeURIComponent(sideQuery)).catch(() => ({ results: [] }));
    const box = $('#side-hits'); if (!box || seq !== searchSeq) return;
    const who = (t) => t.startsWith('bot:') ? bot(t.slice(4))?.name : room(t.slice(5))?.name;
    box.innerHTML = `<h5>Messages</h5>` + (r.results.length ? r.results.map((h) => `<button class="side-hit" data-hit="${h.id}" data-hit-thread="${esc(h.thread)}">
      <span class="row1"><b>${esc(who(h.thread) || h.thread)}</b><span class="time">${stamp(h.at)}</span></span>
      <span class="sub">${esc(h.author === 'user' ? 'You: ' : '')}${esc(h.snippet)}</span></button>`).join('') : '<div class="side-empty">No messages match</div>');
  }, 250);
}
function refreshSideOnly() {
  renderSide();
  const i = $('#side-search'); i.focus(); i.setSelectionRange(i.value.length, i.value.length);
}
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'msg' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
    e.preventDefault(); $('#composer').requestSubmit();
  }
});
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'composer') return;
  e.preventDefault();
  const ta = $('#msg'); const text = ta.value.trim();
  if (/^\/(new|clear)$/i.test(text)) { ta.value = ''; autosize(ta); await api(`/api/bots/${S.current.id}/reset`, { method: 'POST' }); return; }
  if (attachments.some((a) => !a.id && !a.error)) return toast('Still uploading…');
  const files = attachments.filter((a) => a.id).map((a) => a.id);
  if (!text && !files.length) return;
  if(!navigator.onLine)return toast('You’re offline. Your instructions have not been sent.');
  const targetThread=threadKey(),sendKey=JSON.stringify({targetThread,text,files});
  if(!pendingSends.has(sendKey))pendingSends.set(sendKey,crypto.randomUUID());
  const requestId=pendingSends.get(sendKey);
  const kept = attachments;
  const sendBtn = $('.composer .send');
  sendBtn?.classList.remove('launch'); void sendBtn?.offsetWidth; sendBtn?.classList.add('launch');
  buzz(10);
  ta.value = ''; autosize(ta); $('#slash-hint')?.remove(); sessionDraft.delete(threadKey()); attachments = []; drawAttachments();
  try { await api(`/api/threads/${encodeURIComponent(targetThread)}/messages`, { method: 'POST', body: { text, files,requestId } });pendingSends.delete(sendKey); kept.forEach((a) => a.preview && URL.revokeObjectURL(a.preview)); }
  catch (err) { ta.value = text; attachments = kept; drawAttachments(); toast(err.message); }
});

// Paste images/files into the message box, or drop them anywhere on the chat.
document.addEventListener('paste', (e) => {
  if (e.target.id !== 'msg') return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
document.addEventListener('dragover', (e) => { if ($('#composer') && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
document.addEventListener('drop', (e) => {
  document.body.classList.remove('dropping');
  if (!$('#composer') || !e.dataTransfer?.files.length) return;
  e.preventDefault(); addFiles(e.dataTransfer.files);
});

window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (/^(bot|room):\d+$/.test(h) && h !== threadKey()) openThread(h);
});

// ---------- boot ----------
runtimeUI = createRuntimeUI({api,esc,modal,closeModal,toast,bot,avatar,S,openThread,refreshState});
applyTheme();
(async () => {
  await refreshState();
  const hash = location.hash.slice(1);
  const root=rootOrchestrator(),candidates=orchestratorAgents(),first=Object.entries(S.data.last).filter(([key])=>{const[type,id]=key.split(':');return type==='bot'?!!bot(id):type==='room'?!!room(id):false;}).sort((a,b)=>b[1].at-a[1].at)[0]?.[0];
  if (/^(bot|room):\d+$/.test(hash)) openThread(hash);
  else if(matchMedia('(min-width:761px)').matches&&root)openThread('bot:'+root.id);
  else if(candidates.length===0&&matchMedia('(min-width:761px)').matches&&(first||S.data.bots[0]))openThread(first||'bot:'+S.data.bots[0].id);
  else renderMain();
  connect();
})();
