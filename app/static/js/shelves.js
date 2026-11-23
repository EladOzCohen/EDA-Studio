// Explore tab controls: mark picker, shelves (drop zones) and the pill settings menu.
import { S, RECORDS, h, clear, $, emit, on, colOf, makePill, pillLabel, openPopover, closePopover, toast, AGG_NAMES } from './core.js';
import { startDrag, endDrag, readDrag, hasField } from './fields.js';

export const SHELVES = [
  { key: 'x', label: 'X axis' }, { key: 'y', label: 'Y axis' },
  { key: 'color', label: 'Color' }, { key: 'size', label: 'Size' },
  { key: 'col', label: 'Facet columns' }, { key: 'row', label: 'Facet rows' },
];
export const MARKS = [
  { id: 'bar', label: 'Bar' }, { id: 'line', label: 'Line' }, { id: 'area', label: 'Area' }, { id: 'point', label: 'Scatter / dots' },
  { id: 'hist', label: 'Histogram' }, { id: 'box', label: 'Box plot' }, { id: 'heatmap', label: 'Heatmap' },
];
const DATE_PARTS = [['', 'Exact value'], ['year', 'Year'], ['quarter', 'Quarter'], ['month', 'Month'], ['week', 'Week'], ['day', 'Day'], ['hour', 'Hour'],
  ['moy', 'Month of year (seasonality)'], ['dow', 'Day of week'], ['hod', 'Hour of day']];

const changed = () => emit('shelves-changed');

export function placePill(shelf, field, fromShelf) {
  const kind = field === RECORDS ? 'numeric' : colOf(field)?.kind;
  if (kind === 'other') return toast('Nested columns (struct/list) cannot be plotted');
  if (shelf === 'size' && !['point'].includes(S.mark)) toast('Size only applies to Scatter / dots', 'info', 3000);
  let pill = fromShelf && S.shelves[fromShelf] ? S.shelves[fromShelf] : makePill(field);
  if (shelf === 'col' || shelf === 'row') {   // facets split the chart by a dimension, never by an aggregate
    if (field === RECORDS) return toast('Number of Records is a count, not a category — it can’t be used for facets', 'info', 4500);
    if (pill.role === 'measure') pill = { field, role: 'dim', agg: 'none' };
  }
  if (fromShelf && fromShelf !== shelf) {
    S.shelves[fromShelf] = S.shelves[shelf] || null;   // swap with whatever was in the target
  }
  S.shelves[shelf] = pill;
  changed();
}

function pillEl(shelf, p) {
  const c = p.field === RECORDS ? { kind: 'numeric' } : colOf(p.field);
  const measure = p.field === RECORDS || p.role === 'measure';
  const el = h('div', { class: `pill ${measure ? 'measure' : 'dim'}`, draggable: true, title: pillLabel(p),
    ondragstart: e => startDrag(e, { field: p.field, from: shelf }), ondragend: endDrag },
    h('span', { class: 'pill-label' }, pillLabel(p)),
    p.field === RECORDS ? null : h('button', { class: 'pill-btn', title: 'Settings', onclick: e => { e.stopPropagation(); pillMenu(el, p, c); } }, '▾'),
    h('button', { class: 'pill-btn', title: 'Remove', onclick: e => { e.stopPropagation(); S.shelves[shelf] = null; changed(); } }, '×'));
  el.addEventListener('click', () => p.field !== RECORDS && pillMenu(el, p, c));
  return el;
}

export function pillMenu(anchor, p, c, onChange = changed) {
  const body = h('div', { class: 'menu' });
  const redo = () => { closePopover(); onChange(); };
  const item = (label, active, fn) => h('button', { class: `menu-item ${active ? 'active' : ''}`, onclick: fn }, h('span', { class: 'check' }, active ? '✓' : ''), label);
  body.append(h('div', { class: 'menu-title' }, p.field));
  const seg = h('div', { class: 'seg' },
    h('button', { class: p.role !== 'measure' ? 'on' : '', onclick: () => { Object.assign(p, { role: 'dim', agg: 'none' }); if (c.kind === 'temporal') p.trunc = makePill(p.field).trunc; redo(); } }, 'Dimension'),
    h('button', { class: p.role === 'measure' ? 'on' : '', onclick: () => { Object.assign(p, { role: 'measure', agg: c.kind === 'numeric' ? 'sum' : c.kind === 'temporal' ? 'min' : 'countd' }); delete p.trunc; delete p.bin; redo(); } }, 'Measure'));
  body.append(seg);
  if (p.role === 'measure') {
    const aggs = c.kind === 'numeric' ? ['sum', 'avg', 'median', 'min', 'max', 'std', 'count', 'countd', 'none']
      : c.kind === 'temporal' ? ['min', 'max', 'count', 'countd', 'none'] : ['count', 'countd', 'min', 'max'];
    body.append(h('div', { class: 'menu-sub' }, 'Aggregation'), ...aggs.map(a => item(AGG_NAMES[a], (p.agg || 'none') === a, () => { p.agg = a; redo(); })));
  } else if (c.kind === 'temporal') {
    body.append(h('div', { class: 'menu-sub' }, 'Date part'), ...DATE_PARTS.map(([v, l]) => item(l, (p.trunc || '') === v, () => { if (v) p.trunc = v; else delete p.trunc; redo(); })));
  } else if (c.kind === 'numeric') {
    const inp = h('input', { type: 'number', min: 0, step: 'any', placeholder: 'none', value: p.bin || '', class: 'num' });
    inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (v > 0) p.bin = v; else delete p.bin; redo(); });
    body.append(h('div', { class: 'menu-sub' }, 'Bin size (group numbers into buckets)'), h('div', { class: 'menu-row' }, inp));
  }
  openPopover(anchor, body, { width: 240 });
}

function shelfEl({ key, label }) {
  const zone = h('div', { class: 'shelf-zone', dataset: { shelf: key } });
  zone.addEventListener('dragover', e => { if (hasField(e)) { e.preventDefault(); zone.classList.add('over'); } });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => {
    zone.classList.remove('over');
    const d = readDrag(e);
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    placePill(key, d.field, d.from === 'fields' ? null : d.from);
  });
  return h('div', { class: 'shelf' }, h('div', { class: 'shelf-label' }, label), zone);
}

/** Put a field on a sensible shelf of the active chart (double-click / drop on a chart). */
export function placeAuto(field) {
  const c = field === RECORDS ? { kind: 'numeric' } : colOf(field);
  const order = c.kind === 'numeric'
    ? (['hist', 'box'].includes(S.mark) ? (S.mark === 'hist' ? ['x', 'color', 'col'] : ['y', 'color', 'col']) : ['y', 'x', 'color', 'size'])
    : ['x', 'color', 'col', 'y'];
  const free = order.find(k => !S.shelves[k] && !((k === 'col' || k === 'row') && field === RECORDS));
  placePill(free || order[0], field, null);
}

export function renderShelves() {
  const has = !!S.chart;
  $('#editor').classList.toggle('disabled', !has);
  const lbl = $('#editorLabel');
  lbl.textContent = '';
  if (has) {
    // <bdi> isolates the (possibly right-to-left) title so it can't scramble the surrounding English text
    lbl.append('Editing: ', h('bdi', {}, S.chart.title || 'Chart ' + (S.charts.indexOf(S.chart) + 1)));
  } else lbl.textContent = 'No chart selected';
  $('#markSel').value = S.mark;
  $('#optBinsIn').value = S.options.bins;
  $('#optPointsIn').value = S.options.max_points;
  $('#optSortIn').value = S.options.sort;
  for (const { key } of SHELVES) {
    const zone = $(`.shelf-zone[data-shelf="${key}"]`);
    if (!zone) continue;
    clear(zone);
    const p = S.shelves[key];
    zone.append(p ? pillEl(key, p) : h('span', { class: 'placeholder' }, 'drop field'));
  }
  $('#optBins').hidden = S.mark !== 'hist';
  $('#optPoints').hidden = S.mark !== 'point';
  $('#optSort').hidden = !['bar', 'line', 'area', 'point'].includes(S.mark);
}

/** When the mark changes, make aggregation sensible for it (raw for hist/box/scatter; sum for bars). */
function fixPillsForMark() {
  const raw = ['hist', 'box', 'point'].includes(S.mark);
  for (const k of ['x', 'y']) {
    const p = S.shelves[k];
    if (!p || p.field === RECORDS || colOf(p.field)?.kind !== 'numeric' || p.role !== 'measure') continue;
    if (raw && p.agg !== 'none') p.agg = 'none';
    if (!raw && p.agg === 'none') p.agg = 'sum';
  }
}

export function initShelves() {
  const grid = $('#shelves');
  SHELVES.forEach(s => grid.append(shelfEl(s)));
  const sel = $('#markSel');
  MARKS.forEach(m => sel.append(h('option', { value: m.id }, m.label)));
  sel.addEventListener('change', () => { S.mark = sel.value; fixPillsForMark(); changed(); });
  $('#optBinsIn').addEventListener('change', e => { S.options.bins = +e.target.value || 30; changed(); });
  $('#optPointsIn').addEventListener('change', e => { S.options.max_points = +e.target.value || 5000; changed(); });
  $('#optSortIn').addEventListener('change', e => { S.options.sort = e.target.value; changed(); });
  $('#swapBtn').addEventListener('click', () => { [S.shelves.x, S.shelves.y] = [S.shelves.y, S.shelves.x]; changed(); });
  $('#clearBtn').addEventListener('click', () => { for (const k of Object.keys(S.shelves)) S.shelves[k] = null; changed(); });
  on('pill-removed', d => { if (S.shelves[d.from]) { S.shelves[d.from] = null; changed(); } });
}
