// Explore tab: ask the backend for aggregated data, then draw it with Vega-Lite.
import { S, RECORDS, h, clear, $, api, on, colOf, pillLabel, isAggPill, pal, vegaConfig, isDark, fmtInt } from './core.js';

const TIMEUNIT = { year: 'utcyear', quarter: 'utcyearquarter', month: 'utcyearmonth', week: 'utcyearmonthdate', day: 'utcyearmonthdate', hour: 'utcyearmonthdatehours', minute: 'utcyearmonthdatehoursminutes' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

let seq = 0, last = null, timer = null;

export function scheduleChart() {
  clearTimeout(timer);
  timer = setTimeout(refreshChart, 120);
}

export async function refreshChart() {
  const my = ++seq;
  const body = $('#chartBody');
  const shelves = Object.fromEntries(Object.entries(S.shelves).filter(([, v]) => v));
  if (!S.meta || !Object.keys(shelves).length) {
    last = null;
    clear(body).append(h('div', { class: 'empty' }, h('div', { class: 'big' }, 'Drag fields onto the shelves'),
      h('div', {}, 'Dimensions (Aa, ◷) usually go on X, measures (#) on Y. Double-click a field to place it automatically.')));
    $('#chartInfo').textContent = '';
    return;
  }
  $('#chartInfo').textContent = 'Loading…';
  try {
    const resp = await api('/api/chart', { mark: S.mark, shelves, filters: S.filters, options: S.options });
    if (my !== seq) return;
    last = { resp, mark: S.mark, shelves: JSON.parse(JSON.stringify(S.shelves)), options: { ...S.options } };
    draw();
  } catch (e) {
    if (my !== seq) return;
    last = null;
    $('#chartInfo').textContent = '';
    clear(body).append(h('div', { class: 'empty error' }, h('div', { class: 'big' }, 'Can’t draw this yet'), h('div', {}, e.message)));
  }
}

function info(resp, notes) {
  const i = resp.info || {};
  const parts = [];
  if (i.sampled) parts.push(`Showing a random sample of ${fmtInt(i.shown)} of ${fmtInt(i.total)} points`);
  else if (i.aggregated === false) parts.push(`${fmtInt(i.shown)} points`);
  else parts.push(`${fmtInt(resp.rows.length)} ${S.mark === 'box' ? 'groups' : 'marks'}`);
  if (i.truncated) parts.push('result truncated at 50,000 groups — add a filter or a coarser field');
  if (i.outliers_truncated) parts.push('outliers truncated');
  return [...parts, ...notes].join(' · ');
}

export function draw() {
  if (!last) return;
  const body = $('#chartBody');
  const w = Math.max(320, body.clientWidth - 8), hgt = Math.max(260, body.clientHeight - 8);
  let built;
  try { built = buildSpec(last, { w, h: hgt }); } catch (e) {
    clear(body).append(h('div', { class: 'empty error' }, h('div', { class: 'big' }, 'Can’t draw this yet'), h('div', {}, e.message)));
    return;
  }
  $('#chartInfo').textContent = info(last.resp, built.notes);
  if (!built.spec) { clear(body).append(h('div', { class: 'empty' }, built.message)); return; }
  clear(body);
  const host = h('div', { class: 'vega-host' });
  body.append(host);
  window.vegaEmbed(host, built.spec, {
    mode: 'vega-lite', actions: { export: true, source: false, compiled: false, editor: false },
    config: vegaConfig(), renderer: last.resp.rows.length > 3000 ? 'canvas' : 'svg', tooltip: { theme: isDark() ? 'dark' : 'light' },
  }).catch(err => { clear(body).append(h('div', { class: 'empty error' }, h('div', { class: 'big' }, 'Render error'), h('div', {}, String(err.message || err)))); });
}

// ---------------------------------------------------------------- spec building

const numFmt = rows => {
  const m = Math.max(0, ...rows.map(r => Math.abs(+r) || 0));
  return m >= 10000 ? '~s' : ',~g';
};

function shelfEnc(key, pill, ctx, extra = {}) {
  const { rows, st } = ctx;
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
  if (dom.length > 8) notes.push(`${dom.length} color groups — colors repeat after 8; filter or group fewer categories`);
  e.scale = { domain: dom, range: P.cat };
  return e;
}

function facetDef(ctx) {
  const f = {};
  if (ctx.shelves.col) f.column = { ...shelfEnc('col', ctx.shelves.col, ctx), header: { labelOrient: 'top', titleOrient: 'top' } };
  if (ctx.shelves.row) f.row = { ...shelfEnc('row', ctx.shelves.row, ctx), header: { labelOrient: 'left', titleOrient: 'left' } };
  return Object.keys(f).length ? f : null;
}

function buildSpec(snap, box) {
  const { resp, mark, shelves } = snap;
  const notes = [];
  const ctx = { mark, shelves, st: snap, rows: prepRows(resp.rows, shelves) };
  const P = pal();
  const facet = facetDef(ctx);
  const nCol = shelves.col ? new Set(ctx.rows.map(r => r.col)).size : 1;
  const nRow = shelves.row ? new Set(ctx.rows.map(r => r.row)).size : 1;
  const cell = {
    w: Math.max(150, Math.floor((box.w - 120) / nCol) - 20),
    h: Math.max(130, Math.floor((box.h - 70) / nRow) - 30),
  };
  let inner, data = ctx.rows;
  const color = colorEnc(ctx, notes);
  const legendShown = !!color;

  if (mark === 'hist') {
    const vf = resp.info.value_field;
    inner = { mark: { type: 'bar', cornerRadiusEnd: 2, stroke: P.surface, strokeWidth: 1 },
      encoding: { x: { field: 'bin_start', type: 'quantitative', bin: 'binned', title: vf, axis: { format: ',~g' } }, x2: { field: 'bin_end' },
        y: { field: 'count', type: 'quantitative', title: 'Count', axis: { format: '~s' } }, ...(color ? { color } : {}) } };
    if (resp.info.empty) return { notes, message: 'No data' };
  } else if (mark === 'box') {
    return buildBox(resp, ctx, color, facet, cell, box, notes);
  } else {
    const x = shelves.x ? shelfEnc('x', shelves.x, ctx) : null;
    const y = shelves.y ? shelfEnc('y', shelves.y, ctx) : null;
    const enc = { ...(x ? { x } : {}), ...(y ? { y } : {}) };
    if (color) enc.color = color;
    const nomX = x && x.type !== 'quantitative', nomY = y && y.type !== 'quantitative';
    // optional sorting of the discrete axis by the measure
    if (S.options.sort !== 'none' && color == null && (nomX !== nomY)) {
      const d = nomX ? 'x' : 'y', m = nomX ? 'y' : 'x';
      if (enc[d].type !== 'temporal' && !enc[d].sort) enc[d].sort = (S.options.sort === 'desc' ? '-' : '') + m;
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
    } else { // bar
      inner = { mark: { type: 'bar', cornerRadiusEnd: 4, stroke: P.surface, strokeWidth: color ? 1 : 0 }, encoding: enc };
    }
  }
  const spec = facet
    ? { data: { values: data }, facet, spec: { ...inner, width: cell.w, height: cell.h }, resolve: { scale: { x: 'shared', y: 'shared' } } }
    : { data: { values: data }, ...inner, width: Math.max(200, box.w - (legendShown ? 190 : 90)), height: Math.max(180, box.h - 90), autosize: { type: 'fit', contains: 'padding' } };
  return { spec, notes };
}

function buildBox(resp, ctx, color, facet, cell, box, notes) {
  const { shelves } = ctx;
  const P = pal();
  const orient = resp.info.orient;
  const catKey = orient === 'v' ? 'x' : 'y';
  const ch = orient === 'v' ? { c: 'x', v: 'y', v2: 'y2', off: 'xOffset', size: 'width' } : { c: 'y', v: 'x', v2: 'x2', off: 'yOffset', size: 'height' };
  const vf = resp.info.value_field;
  const rows = [...ctx.rows.map(r => ({ ...r, kind: 'box' })), ...resp.outliers.map(r => ({ ...r, kind: 'out' }))];
  let cat;
  if (shelves[catKey]) cat = shelfEnc(catKey, shelves[catKey], { ...ctx, rows: ctx.rows });
  else { rows.forEach(r => (r._c = vf)); cat = { field: '_c', type: 'nominal', title: null, axis: { labels: false, ticks: false } }; }
  const off = color ? { [ch.off]: { field: 'color', type: color.type === 'quantitative' ? 'ordinal' : 'nominal' } } : {};
  const col = color ? { color } : {};
  const val = (field, extra = {}) => ({ field, type: 'quantitative', title: vf, scale: { zero: false }, axis: { format: ',~g' }, ...extra });
  const bw = color ? 14 : 34;
  const layers = [
    { transform: [{ filter: "datum.kind === 'box'" }], mark: { type: 'rule', color: P.muted }, encoding: { [ch.c]: cat, [ch.v]: val('lo'), [ch.v2]: { field: 'hi' }, ...off } },
    { transform: [{ filter: "datum.kind === 'box'" }], mark: { type: 'bar', size: bw, cornerRadius: 3, ...(color ? {} : { color: P.cat[0] }), opacity: 0.9 },
      encoding: { [ch.c]: cat, [ch.v]: val('q1'), [ch.v2]: { field: 'q3' }, ...off, ...col } },
    { transform: [{ filter: "datum.kind === 'box'" }], mark: { type: 'tick', size: bw, thickness: 2.5, color: P.surface }, encoding: { [ch.c]: cat, [ch.v]: val('median'), ...off } },
    { transform: [{ filter: "datum.kind === 'out'" }], mark: { type: 'circle', size: 14, opacity: 0.45, ...(color ? {} : { color: P.cat[0] }) },
      encoding: { [ch.c]: cat, [ch.v]: val('value'), ...off, ...col } },
  ];
  const spec = facet
    ? { data: { values: rows }, facet, spec: { layer: layers, width: cell.w, height: cell.h } }
    : { data: { values: rows }, layer: layers, width: Math.max(200, box.w - (color ? 190 : 90)), height: Math.max(180, box.h - 90), autosize: { type: 'fit', contains: 'padding' } };
  notes.push('Box = Q1–Q3, line = median, whiskers = 1.5×IQR, dots = outliers');
  return { spec, notes };
}

export function initChart() {
  new ResizeObserver(() => { clearTimeout(initChart.t); initChart.t = setTimeout(draw, 200); }).observe($('#chartBody'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
  on('shelves-changed', scheduleChart);
  on('filters-changed', () => S.tab === 'explore' && scheduleChart());
}
