// Per-chart rendering: ask the backend for aggregated data, then draw it with Vega-Lite.
import { S, RECORDS, h, clear, api, on, colOf, pillLabel, isAggPill, pal, vegaConfig, isDark, fmtInt } from './core.js';

const TIMEUNIT = { year: 'utcyear', quarter: 'utcyearquarter', month: 'utcyearmonth', week: 'utcyearmonthdate', day: 'utcyearmonthdate', hour: 'utcyearmonthdatehours', minute: 'utcyearmonthdatehoursminutes' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const parts = c => {
  const card = document.querySelector(`.card[data-id="${c.id}"]`);
  return card ? { card, body: card.querySelector('.card-body'), info: card.querySelector('.card-info') } : null;
};

export function scheduleChart(c) {
  if (!c) return;
  clearTimeout(c._timer);
  c._timer = setTimeout(() => refreshChart(c), 120);
}
export const refreshAll = () => S.charts.forEach(scheduleChart);
export const redrawAll = () => S.charts.forEach(drawChart);

function message(el, title, text, cls = '') {
  clear(el).append(h('div', { class: `empty ${cls}` }, h('div', { class: 'big' }, title), text ? h('div', {}, text) : null));
}

export async function refreshChart(c) {
  const p = parts(c);
  if (!p) return;
  const my = c._seq = (c._seq || 0) + 1;
  const shelves = Object.fromEntries(Object.entries(c.shelves).filter(([, v]) => v));
  if (!S.meta || !Object.keys(shelves).length) {
    c._resp = null; c._view = null;
    p.info.textContent = '';
    message(p.body, 'Empty chart', 'Drag fields onto the shelves above, or drop them right here. Double-click a field to place it automatically.');
    return;
  }
  p.info.textContent = 'Loading…';
  try {
    const resp = await api('/api/chart', { mark: c.mark, shelves, filters: S.filters, options: c.options });
    if (my !== c._seq) return;
    c._resp = { resp, mark: c.mark, shelves: JSON.parse(JSON.stringify(c.shelves)), options: { ...c.options } };
    drawChart(c);
  } catch (e) {
    if (my !== c._seq) return;
    c._resp = null; c._view = null;
    p.info.textContent = '';
    message(p.body, 'Can’t draw this yet', e.message, 'error');
  }
}

function infoText(snap, notes) {
  const { resp, mark } = snap;
  const i = resp.info || {};
  const out = [];
  if (i.sampled) out.push(`Random sample: ${fmtInt(i.shown)} of ${fmtInt(i.total)} points`);
  else if (i.aggregated === false) out.push(`${fmtInt(i.shown)} points`);
  else out.push(`${fmtInt(resp.rows.length)} ${mark === 'box' ? 'groups' : 'marks'}`);
  if (i.truncated) out.push('truncated at 50,000 groups');
  if (i.outliers_truncated) out.push('outliers truncated');
  return [...out, ...notes].join(' · ');
}

export function drawChart(c) {
  const snap = c._resp, p = parts(c);
  if (!snap || !p) return;
  const w = Math.max(240, p.body.clientWidth - 8), hgt = Math.max(160, p.body.clientHeight - 8);
  if (p.body.clientWidth < 10) return;   // hidden tab: will redraw when shown
  let built;
  try { built = buildSpec(snap, { w, h: hgt }); } catch (e) { message(p.body, 'Can’t draw this yet', e.message, 'error'); p.info.textContent = ''; return; }
  p.info.textContent = infoText(snap, built.notes);
  p.info.title = p.info.textContent;
  if (!built.spec) { c._view = null; message(p.body, 'Almost there', built.message); return; }
  clear(p.body);
  const host = h('div', { class: 'vega-host' });
  p.body.append(host);
  window.vegaEmbed(host, built.spec, {
    mode: 'vega-lite', actions: false, config: vegaConfig(), renderer: snap.resp.rows.length > 3000 ? 'canvas' : 'svg', tooltip: { theme: isDark() ? 'dark' : 'light' },
  }).then(r => { c._view = r.view; })
    .catch(err => message(p.body, 'Render error', String(err.message || err), 'error'));
}

// ---------------------------------------------------------------- spec building

const numFmt = rows => {
  const m = Math.max(0, ...rows.map(r => Math.abs(+r) || 0));
  return m >= 10000 ? '~s' : ',.6~g';
};

function shelfEnc(key, pill, ctx, extra = {}) {
  const { rows } = ctx;
  const title = pillLabel(pill);
  const col = pill.field === RECORDS ? { kind: 'numeric' } : colOf(pill.field);
  if (isAggPill(pill) || pill.role === 'measure') {
    const raw = !isAggPill(pill);
    const enc = { field: key, type: 'quantitative', title, ...extra };
    if (['x', 'y'].includes(key)) {
      enc.axis = { ...(extra.axis || {}), format: numFmt(rows.map(r => r[key])) };
      if (raw && ['point', 'hist'].includes(ctx.mark)) enc.scale = { ...(extra.scale || {}), zero: false };
    }
    return enc;
  }
  if (col.kind === 'temporal') {
    if (pill.trunc && TIMEUNIT[pill.trunc]) return { field: key, type: 'temporal', timeUnit: TIMEUNIT[pill.trunc], title, ...extra };
    if (pill.trunc === 'moy') return { field: key, type: 'ordinal', title, sort: MONTHS, ...extra };
    if (pill.trunc === 'dow') return { field: key, type: 'ordinal', title, sort: DAYS, ...extra };
    if (pill.trunc === 'hod') return { field: key, type: 'ordinal', title, ...extra };
    return { field: key, type: 'temporal', title, ...extra };
  }
  if (col.kind === 'numeric') return { field: key, type: 'ordinal', title, ...extra };
  return { field: key, type: 'nominal', title, ...extra };
}

function prepRows(rows, shelves) {
  const maps = {};
  for (const [k, p] of Object.entries(shelves)) {
    if (!p || p.field === RECORDS) continue;
    if (p.trunc === 'moy') maps[k] = v => MONTHS[v - 1];
    if (p.trunc === 'dow') maps[k] = v => DAYS[v - 1];
  }
  if (!Object.keys(maps).length) return rows;
  return rows.map(r => { const o = { ...r }; for (const [k, f] of Object.entries(maps)) if (o[k] != null) o[k] = f(o[k]); return o; });
}

function colorEnc(ctx, notes) {
  const p = ctx.shelves.color;
  if (!p) return null;
  const P = pal();
  const e = shelfEnc('color', p, ctx);
  if (e.type === 'quantitative') { e.scale = { range: P.seq }; e.legend = { gradientLength: 140 }; return e; }
  const dom = [...new Set(ctx.rows.map(r => r.color))].filter(v => v !== null).sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
  if (dom.length > 8) notes.push(`${dom.length} color groups — colors repeat after 8`);
  e.scale = { domain: dom, range: P.cat };
  return e;
}

function facetDef(ctx) {
  const f = {};
  for (const [key, label] of [['col', 'Facet columns'], ['row', 'Facet rows']]) {
    const p = ctx.shelves[key];
    if (!p) continue;
    if (isAggPill(p) || p.role === 'measure') throw new Error(`${label} must be a dimension (Aa / ◷), but “${pillLabel(p)}” is a measure. Click the pill and choose “Dimension”, or move it to Y.`);
    f[key === 'col' ? 'column' : 'row'] = { ...shelfEnc(key, p, ctx), header: key === 'col' ? { labelOrient: 'top', titleOrient: 'top' } : { labelOrient: 'left', titleOrient: 'left' } };
  }
  return Object.keys(f).length ? f : null;
}

function buildSpec(snap, box) {
  const { resp, mark, shelves, options } = snap;
  const notes = [];
  const ctx = { mark, shelves, rows: prepRows(resp.rows, shelves) };
  const P = pal();
  const facet = facetDef(ctx);
  const nCol = shelves.col ? new Set(ctx.rows.map(r => r.col)).size : 1;
  const nRow = shelves.row ? new Set(ctx.rows.map(r => r.row)).size : 1;
  const cell = { w: Math.max(120, Math.floor((box.w - 110) / nCol) - 16), h: Math.max(110, Math.floor((box.h - 60) / nRow) - 26) };
  const color = colorEnc(ctx, notes);
  let inner;

  if (['bar', 'line', 'area'].includes(mark) && !['x', 'y'].some(k => shelves[k] && (isAggPill(shelves[k]) || shelves[k].role === 'measure'))) {
    return { notes, message: 'Add a measure (#) to the X or Y axis — or use “Number of Records” for a simple count.' };
  }
  if (mark === 'hist') {
    if (resp.info.empty) return { notes, message: 'No data' };
    const vf = resp.info.value_field;
    inner = { mark: { type: 'bar', cornerRadiusEnd: 2, stroke: P.surface, strokeWidth: 1 },
      encoding: { x: { field: 'bin_start', type: 'quantitative', bin: 'binned', title: vf, axis: { format: ',.6~g' } }, x2: { field: 'bin_end' },
        y: { field: 'count', type: 'quantitative', title: 'Count', axis: { format: '~s' } }, ...(color ? { color } : {}) } };
  } else if (mark === 'box') {
    return buildBox(resp, ctx, color, facet, cell, box, notes);
  } else {
    const x = shelves.x ? shelfEnc('x', shelves.x, ctx) : null;
    const y = shelves.y ? shelfEnc('y', shelves.y, ctx) : null;
    const enc = { ...(x ? { x } : {}), ...(y ? { y } : {}) };
    if (color) enc.color = color;
    const nomX = x && x.type !== 'quantitative', nomY = y && y.type !== 'quantitative';
    if (options.sort !== 'none' && color == null && (nomX !== nomY)) {   // sort the discrete axis by the measure
      const d = nomX ? 'x' : 'y', m = nomX ? 'y' : 'x';
      if (enc[d].type !== 'temporal' && !enc[d].sort) enc[d].sort = (options.sort === 'desc' ? '-' : '') + m;
    }
    if (mark === 'point') {
      if (shelves.size) enc.size = { ...shelfEnc('size', shelves.size, ctx), legend: { symbolFillColor: P.muted } };
      const many = ctx.rows.length > 1500;
      const m = { type: 'circle', opacity: many ? 0.4 : 0.75, ...(shelves.size ? {} : { size: many ? 22 : 45 }) };
      if (!color) m.color = P.cat[0];
      inner = { mark: m, encoding: enc };
    } else if (mark === 'line') {
      inner = { mark: { type: 'line', strokeWidth: 2, strokeJoin: 'round', point: ctx.rows.length <= 80 ? { size: 50, filled: true } : false }, encoding: enc };
      if (x && x.type === 'nominal' && !x.sort) x.sort = null;
    } else if (mark === 'area') {
      inner = { mark: { type: 'area', opacity: 0.85, line: { strokeWidth: 2 } }, encoding: enc };
    } else if (mark === 'heatmap') {
      if (!color) return { notes, message: 'Heatmap: dimensions on X and Y, and a measure (or Number of Records) on Color.' };
      inner = { mark: { type: 'rect', stroke: P.surface, strokeWidth: 1 }, encoding: enc };
    } else {
      inner = { mark: { type: 'bar', cornerRadiusEnd: 4, stroke: P.surface, strokeWidth: color ? 1 : 0 }, encoding: enc };
    }
  }
  const data = ctx.rows;
  const spec = facet
    ? { data: { values: data }, facet, spec: { ...inner, width: cell.w, height: cell.h }, resolve: { scale: { x: 'shared', y: 'shared' } } }
    : { data: { values: data }, ...inner, width: Math.max(160, box.w), height: Math.max(120, box.h), autosize: { type: 'fit', contains: 'padding' } };
  return { spec, notes };
}

function buildBox(resp, ctx, color, facet, cell, box, notes) {
  const { shelves } = ctx;
  const P = pal();
  const orient = resp.info.orient;
  const catKey = orient === 'v' ? 'x' : 'y';
  const ch = orient === 'v' ? { c: 'x', v: 'y', v2: 'y2', off: 'xOffset' } : { c: 'y', v: 'x', v2: 'x2', off: 'yOffset' };
  const vf = resp.info.value_field;
  const rows = [...ctx.rows.map(r => ({ ...r, kind: 'box' })), ...resp.outliers.map(r => ({ ...r, kind: 'out' }))];
  let cat;
  if (shelves[catKey]) cat = shelfEnc(catKey, shelves[catKey], ctx);
  else { rows.forEach(r => (r._c = vf)); cat = { field: '_c', type: 'nominal', title: null, axis: { labels: false, ticks: false } }; }
  const off = color ? { [ch.off]: { field: 'color', type: color.type === 'quantitative' ? 'ordinal' : 'nominal' } } : {};
  const col = color ? { color } : {};
  const val = (field, extra = {}) => ({ field, type: 'quantitative', title: vf, scale: { zero: false }, axis: { format: ',.6~g' }, ...extra });
  const bw = color ? 14 : 34;
  const box_ = "datum.kind === 'box'";
  const layers = [
    { transform: [{ filter: box_ }], mark: { type: 'rule', color: P.muted }, encoding: { [ch.c]: cat, [ch.v]: val('lo'), [ch.v2]: { field: 'hi' }, ...off } },
    { transform: [{ filter: box_ }], mark: { type: 'bar', size: bw, cornerRadius: 3, ...(color ? {} : { color: P.cat[0] }), opacity: 0.9 },
      encoding: { [ch.c]: cat, [ch.v]: val('q1'), [ch.v2]: { field: 'q3' }, ...off, ...col } },
    { transform: [{ filter: box_ }], mark: { type: 'tick', size: bw, thickness: 2.5, color: P.surface }, encoding: { [ch.c]: cat, [ch.v]: val('median'), ...off } },
    { transform: [{ filter: "datum.kind === 'out'" }], mark: { type: 'circle', size: 14, opacity: 0.45, ...(color ? {} : { color: P.cat[0] }) },
      encoding: { [ch.c]: cat, [ch.v]: val('value'), ...off, ...col } },
  ];
  const spec = facet
    ? { data: { values: rows }, facet, spec: { layer: layers, width: cell.w, height: cell.h } }
    : { data: { values: rows }, layer: layers, width: Math.max(160, box.w), height: Math.max(120, box.h), autosize: { type: 'fit', contains: 'padding' } };
  notes.push('Box = Q1–Q3, line = median, whiskers = 1.5×IQR');
  return { spec, notes };
}

// Keep a reference: a MediaQueryList with no strong reference can be garbage-collected together with its listener.
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

export function initChart() {
  on('shelves-changed', () => scheduleChart(S.chart));
  on('filters-changed', () => S.tab === 'explore' && refreshAll());
  on('theme-changed', () => S.tab === 'explore' && redrawAll());
  darkQuery.addEventListener('change', () => (S.tab === 'explore' ? redrawAll() : null));
}
