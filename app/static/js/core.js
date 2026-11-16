// Shared state, DOM helpers, API client and pill helpers.

export const RECORDS = '__records__';

export const S = {
  meta: null,            // loaded dataset (columns, n_rows, ...)
  tab: 'explore',
  mark: 'bar',
  shelves: { x: null, y: null, color: null, size: null, col: null, row: null },
  options: { bins: 30, max_points: 5000, sort: 'none' },
  filters: [],
  analyses: [],
  analysisId: 'descriptives',
  slots: {},             // analysisId -> {slotKey: [fields]}
  aopts: {},             // analysisId -> {optKey: value}
};

// ---- tiny pub/sub -------------------------------------------------------
const listeners = {};
export const on = (ev, fn) => ((listeners[ev] ||= []).push(fn), fn);
export const emit = (ev, data) => (listeners[ev] || []).forEach(fn => fn(data));

// ---- DOM helper ---------------------------------------------------------
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in e && k !== 'list' && k !== 'style') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

// ---- API ----------------------------------------------------------------
export async function api(path, body, { method } = {}) {
  const opts = body === undefined && !method
    ? {}
    : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) };
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  if (!res.ok) throw new Error(data?.detail ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : `HTTP ${res.status}`);
  return data;
}

// ---- toasts -------------------------------------------------------------
export function toast(msg, kind = 'error', ms = 6000) {
  const host = $('#toasts');
  const t = h('div', { class: `toast ${kind}` }, msg);
  host.append(t);
  setTimeout(() => t.remove(), ms);
}

// ---- popover ------------------------------------------------------------
let currentPop = null;
export function closePopover() {
  if (!currentPop) return;
  currentPop.el.remove();
  document.removeEventListener('mousedown', currentPop.outside, true);
  document.removeEventListener('keydown', currentPop.key, true);
  const cb = currentPop.onClose;
  currentPop = null;
  cb && cb();
}
export function openPopover(anchor, content, { onClose, width } = {}) {
  closePopover();
  const el = h('div', { class: 'popover', style: width ? { width: width + 'px' } : {} }, content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const pw = el.offsetWidth, ph = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - pw - 8)) + 'px';
  el.style.top = (r.bottom + ph + 12 > innerHeight ? Math.max(8, r.top - ph - 4) : r.bottom + 4) + 'px';
  const outside = e => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const key = e => { if (e.key === 'Escape') closePopover(); };
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', key, true);
  currentPop = { el, outside, key, onClose };
  return el;
}

// ---- formatting ---------------------------------------------------------
export function fmtCell(v, fmt) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') return v;
  if (fmt === 'p') return v < 0.001 ? '< .001' : v.toFixed(3);
  if (fmt === 'int') return Math.round(v).toLocaleString();
  if (fmt === 'num') {
    if (!isFinite(v)) return v > 0 ? '∞' : '−∞';
    const a = Math.abs(v);
    if (a !== 0 && (a < 0.001 || a >= 1e7)) return v.toExponential(2);
    return v.toLocaleString(undefined, { maximumFractionDigits: 3, minimumFractionDigits: Number.isInteger(v) ? 0 : 3 });
  }
  return String(v);
}
export const fmtInt = n => (n ?? 0).toLocaleString();

// ---- dataset helpers ----------------------------------------------------
export const colOf = name => S.meta?.columns.find(c => c.name === name);
export const kindOf = name => (name === RECORDS ? 'numeric' : colOf(name)?.kind);

const AGG_LABEL = { sum: 'SUM', avg: 'AVG', median: 'MEDIAN', min: 'MIN', max: 'MAX', std: 'STDEV', count: 'COUNT', countd: 'COUNTD' };
export const AGG_NAMES = { sum: 'Sum', avg: 'Average', median: 'Median', min: 'Minimum', max: 'Maximum', std: 'Std. deviation', count: 'Count', countd: 'Count (distinct)', none: 'None (raw values)' };
export const TRUNC_LABEL = { year: 'YEAR', quarter: 'QUARTER', month: 'MONTH', week: 'WEEK', day: 'DAY', hour: 'HOUR', minute: 'MINUTE', moy: 'MONTH OF YEAR', dow: 'WEEKDAY', hod: 'HOUR OF DAY' };

export function pillLabel(p) {
  if (p.field === RECORDS) return 'Number of Records';
  if (p.role === 'measure' && p.agg && p.agg !== 'none') return `${AGG_LABEL[p.agg]}(${p.field})`;
  if (p.trunc) return `${TRUNC_LABEL[p.trunc]}(${p.field})`;
  if (p.bin) return `BIN(${p.field}, ${p.bin})`;
  return p.field;
}
export const isAggPill = p => p.field === RECORDS || (p.role === 'measure' && p.agg && p.agg !== 'none');

/** Default pill for a field dropped on a shelf (Tableau-like defaults). */
export function makePill(field, mark = S.mark) {
  if (field === RECORDS) return { field, role: 'measure', agg: 'count' };
  const c = colOf(field);
  if (c.kind === 'numeric') {
    const raw = ['hist', 'box', 'point'].includes(mark);
    return { field, role: 'measure', agg: raw ? 'none' : 'sum' };
  }
  if (c.kind === 'temporal') {
    const span = (new Date(c.max) - new Date(c.min)) / 86400000;
    return { field, role: 'dim', agg: 'none', trunc: span > 1000 ? 'month' : span > 90 ? 'week' : 'day' };
  }
  return { field, role: 'dim', agg: 'none' };
}

// ---- theme --------------------------------------------------------------
export const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
export const PALETTE = {
  light: { cat: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'], surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7',
    seq: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'], mid: '#f0efec' },
  dark: { cat: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'], surface: '#1a1a19', ink: '#f0efec', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835',
    seq: ['#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'], mid: '#383835' },
};
export const pal = () => PALETTE[isDark() ? 'dark' : 'light'];

export function vegaConfig() {
  const p = pal();
  return {
    background: p.surface,
    font: 'Segoe UI, system-ui, -apple-system, sans-serif',
    view: { stroke: null },
    axis: { domainColor: p.axis, tickColor: p.axis, gridColor: p.grid, labelColor: p.ink2, titleColor: p.ink2, labelFontSize: 11, titleFontSize: 12, titleFontWeight: 500, labelLimit: 160 },
    axisX: { labelAngle: -0, labelOverlap: 'parity' },
    scale: { bandPaddingInner: 0.3, bandPaddingOuter: 0.15 },
    legend: { labelColor: p.ink2, titleColor: p.ink2, labelFontSize: 11, titleFontSize: 12, symbolType: 'circle' },
    header: { labelColor: p.ink2, titleColor: p.ink2, labelFontSize: 11, titleFontSize: 12 },
    title: { color: p.ink },
    range: { category: p.cat, ramp: p.seq, heatmap: p.seq },
    mark: { color: p.cat[0] },
    bar: { cornerRadiusEnd: 4 },
    line: { strokeWidth: 2 },
    point: { filled: true },
    text: { color: p.ink },
  };
}
