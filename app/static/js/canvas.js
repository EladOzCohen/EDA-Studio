// The canvas: several charts side by side. Chart types are dragged in from the palette.
import { S, RECORDS, h, clear, $, on, emit, newChart, toast, pal } from './core.js';
import { readDrag, hasField } from './fields.js';
import { MARKS, placeAuto, renderShelves } from './shelves.js';
import { scheduleChart, refreshChart, drawChart } from './chart.js';

const CHART_MIME = 'application/x-eda-chart';
const CARD_MIME = 'application/x-eda-card';

const ICONS = {
  bar: '<rect x="3" y="12" width="4" height="9"/><rect x="10" y="6" width="4" height="15"/><rect x="17" y="9" width="4" height="12"/>',
  line: '<polyline points="3,17 9,10 14,14 21,5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>',
  area: '<path d="M3 20V13l6-5 5 4 7-7v15z" opacity=".85"/>',
  point: '<circle cx="6" cy="16" r="2"/><circle cx="11" cy="9" r="2"/><circle cx="15" cy="15" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="9" cy="19" r="1.6"/>',
  hist: '<rect x="3" y="14" width="3.5" height="7"/><rect x="7" y="8" width="3.5" height="13"/><rect x="11" y="4" width="3.5" height="17"/><rect x="15" y="10" width="3.5" height="11"/><rect x="19" y="17" width="2.5" height="4"/>',
  box: '<rect x="6" y="8" width="12" height="8" rx="1.5" opacity=".85"/><path d="M12 3v5M12 16v5M9 3h6M9 21h6M6 12h12" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  heatmap: '<rect x="3" y="3" width="8" height="8" opacity=".35"/><rect x="13" y="3" width="8" height="8" opacity=".9"/><rect x="3" y="13" width="8" height="8" opacity=".65"/><rect x="13" y="13" width="8" height="8" opacity=".5"/>',
};
const icon = m => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'currentColor'); s.setAttribute('width', '26'); s.setAttribute('height', '26'); s.innerHTML = ICONS[m]; return s; };

// ------------------------------------------------------------- chart list
export function addChart(mark = 'bar', beforeId = null) {
  const c = newChart(mark);
  const i = beforeId ? S.charts.findIndex(x => x.id === beforeId) : -1;
  if (i >= 0) S.charts.splice(i, 0, c); else S.charts.push(c);
  renderCanvas();
  selectChart(c.id);
  requestAnimationFrame(() => document.querySelector(`.card[data-id="${c.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  return c;
}
export function resetCharts() {
  S.charts = [];
  S.activeId = null;
  renderCanvas();
  if (S.meta) addChart('bar');
}
function removeChart(id) {
  const i = S.charts.findIndex(c => c.id === id);
  if (i < 0) return;
  S.charts.splice(i, 1);
  if (S.activeId === id) S.activeId = (S.charts[i] || S.charts[i - 1] || {}).id || null;
  renderCanvas();
  syncActive();
}
function duplicateChart(id) {
  const src = S.charts.find(c => c.id === id);
  if (!src) return;
  const c = newChart(src.mark);
  Object.assign(c, { shelves: JSON.parse(JSON.stringify(src.shelves)), options: { ...src.options }, title: src.title ? src.title + ' (copy)' : '', footnote: src.footnote, w: src.w, h: src.h });
  S.charts.splice(S.charts.indexOf(src) + 1, 0, c);
  renderCanvas();
  selectChart(c.id);
}
export function selectChart(id) {
  if (S.activeId === id && document.querySelector('.card.active')) return;
  S.activeId = id;
  syncActive();
}
function syncActive() {
  document.querySelectorAll('.card').forEach(el => el.classList.toggle('active', el.dataset.id === S.activeId));
  renderShelves();
}

// ------------------------------------------------------------- export (title + footnote are included)
function wrap(ctx, text, maxW) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = word; } else line = test;
    }
    lines.push(line);
  }
  return lines;
}
async function chartCanvas(c) {
  if (!c._view) throw new Error('Nothing to export yet');
  const P = pal(), sc = 2;
  const plot = await c._view.toCanvas(sc);
  const pad = 14 * sc;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `600 ${16 * sc}px "Segoe UI", sans-serif`;
  const tLines = c.title ? wrap(probe, c.title, plot.width - 2 * pad) : [];
  probe.font = `${12 * sc}px "Segoe UI", sans-serif`;
  const fLines = c.footnote ? wrap(probe, c.footnote, plot.width - 2 * pad) : [];
  const tH = tLines.length ? tLines.length * 22 * sc + 8 * sc : 0, fH = fLines.length ? fLines.length * 16 * sc + 12 * sc : 0;
  const out = document.createElement('canvas');
  out.width = plot.width; out.height = plot.height + tH + fH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = P.surface; ctx.fillRect(0, 0, out.width, out.height);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = P.ink; ctx.font = `600 ${16 * sc}px "Segoe UI", sans-serif`;
  tLines.forEach((l, i) => ctx.fillText(l, pad, (20 + i * 22) * sc));
  ctx.drawImage(plot, 0, tH);
  ctx.fillStyle = P.ink2; ctx.font = `${12 * sc}px "Segoe UI", sans-serif`;
  fLines.forEach((l, i) => ctx.fillText(l, pad, tH + plot.height + (4 + 12 + i * 16) * sc));
  return out;
}
async function downloadPng(c) {
  try {
    const cv = await chartCanvas(c);
    const a = h('a', { href: cv.toDataURL('image/png'), download: (c.title || 'chart').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '.png' });
    document.body.append(a); a.click(); a.remove();
  } catch (e) { toast(e.message); }
}
async function copyPng(c) {
  try {
    const cv = await chartCanvas(c);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Chart copied — paste it into PowerPoint / Word / Teams', 'info', 2500);
  } catch (e) { toast(e.message || 'Copy failed'); }
}

// ------------------------------------------------------------- cards
let dragCardId = null;
const sizeObserver = new ResizeObserver(entries => {
  for (const en of entries) {
    const el = en.target, c = S.charts.find(x => x.id === el.dataset.id);
    if (!c || el.offsetWidth < 50) continue;   // ignore hidden-tab / detached zero sizes
    c.w = el.offsetWidth; c.h = el.offsetHeight;
    clearTimeout(c._rt);
    c._rt = setTimeout(() => drawChart(c), 150);
  }
});

function cardEl(c) {
  const title = h('input', { class: 'card-title', type: 'text', placeholder: 'Add a title…', value: c.title, spellcheck: false,
    oninput: e => { c.title = e.target.value; if (S.activeId === c.id) renderShelves(); } });
  const foot = h('textarea', { class: 'card-foot', rows: 1, placeholder: 'Add a footnote…', value: c.footnote, spellcheck: false,
    oninput: e => { c.footnote = e.target.value; e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; },
    onchange: () => drawChart(c) });
  foot.value = c.footnote;
  const btn = (label, tip, fn) => h('button', { class: 'card-btn', title: tip, onclick: e => { e.stopPropagation(); fn(); } }, label);
  const handle = h('span', { class: 'card-handle', draggable: true, title: 'Drag to reorder' }, '⋮⋮');
  const body = h('div', { class: 'card-body' });
  const el = h('div', { class: 'card' + (c.id === S.activeId ? ' active' : ''), dataset: { id: c.id }, style: { width: c.w + 'px', height: c.h + 'px' } },
    h('div', { class: 'card-head' }, handle, title, h('span', { class: 'card-info muted' }),
      btn('⧉', 'Duplicate chart', () => duplicateChart(c.id)), btn('⤓', 'Download PNG (with title & footnote)', () => downloadPng(c)),
      btn('❐', 'Copy image to clipboard', () => copyPng(c)), btn('×', 'Remove chart', () => removeChart(c.id))),
    body, foot);

  el.addEventListener('mousedown', () => selectChart(c.id), true);
  handle.addEventListener('dragstart', e => {
    dragCardId = c.id;
    e.dataTransfer.setData(CARD_MIME, c.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(el, 20, 20);
  });
  handle.addEventListener('dragend', () => { dragCardId = null; document.querySelectorAll('.card.drop-before').forEach(x => x.classList.remove('drop-before')); });
  // reorder: drop another card on this one
  el.addEventListener('dragover', e => {
    const t = [...e.dataTransfer.types];
    if (t.includes(CARD_MIME) && dragCardId !== c.id) { e.preventDefault(); el.classList.add('drop-before'); }
    else if (t.includes('application/x-eda-field')) { e.preventDefault(); body.classList.add('over'); }
  });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) { el.classList.remove('drop-before'); body.classList.remove('over'); } });
  el.addEventListener('drop', e => {
    el.classList.remove('drop-before'); body.classList.remove('over');
    const t = [...e.dataTransfer.types];
    if (t.includes(CARD_MIME) && dragCardId && dragCardId !== c.id) {
      e.preventDefault(); e.stopPropagation();
      const from = S.charts.findIndex(x => x.id === dragCardId), target = S.charts.findIndex(x => x.id === c.id);
      const [moved] = S.charts.splice(from, 1);
      S.charts.splice(from < target ? target : target, 0, moved);   // dragging forward lands after the target, backward before it
      renderCanvas(); syncActive();
    } else if (t.includes('application/x-eda-field')) {   // a field dropped straight onto the chart
      const d = readDrag(e);
      if (d && d.from === 'fields') { e.preventDefault(); e.stopPropagation(); selectChart(c.id); placeAuto(d.field); }
    }
  });
  sizeObserver.observe(el);
  requestAnimationFrame(() => { foot.style.height = 'auto'; foot.style.height = foot.scrollHeight + 'px'; });
  return el;
}

export function renderCanvas() {
  const root = $('#canvas');
  root.querySelectorAll('.card').forEach(el => sizeObserver.unobserve(el));
  clear(root);
  if (!S.charts.length) {
    root.append(h('div', { class: 'canvas-empty' }, h('div', { class: 'big' }, 'Your canvas is empty'), h('div', {}, 'Drag a chart type from the “Charts” panel on the left onto this area.')));
    return;
  }
  S.charts.forEach(c => root.append(cardEl(c)));
  S.charts.forEach(c => requestAnimationFrame(() => (c._resp ? drawChart(c) : refreshChart(c))));
}

export function initCanvas() {
  const pal_ = $('#palette');
  MARKS.forEach(m => pal_.append(h('div', { class: 'tile', draggable: true, title: 'Drag onto the canvas (or click to add)',
    ondragstart: e => { e.dataTransfer.setData(CHART_MIME, m.id); e.dataTransfer.effectAllowed = 'copy'; document.body.classList.add('dragging'); },
    ondragend: () => document.body.classList.remove('dragging'),
    onclick: () => S.meta && addChart(m.id) }, icon(m.id), h('span', {}, m.label))));
  const canvas = $('#canvas');
  canvas.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes(CHART_MIME)) { e.preventDefault(); canvas.classList.add('over'); } });
  canvas.addEventListener('dragleave', e => { if (!canvas.contains(e.relatedTarget)) canvas.classList.remove('over'); });
  canvas.addEventListener('drop', e => {
    canvas.classList.remove('over');
    const mark = e.dataTransfer.getData(CHART_MIME);
    if (mark && S.meta) { e.preventDefault(); addChart(mark); }
  });
  $('#addChartBtn').addEventListener('click', () => S.meta && addChart(S.chart?.mark || 'bar'));
  on('chart-selected', syncActive);
  on('field-activate', field => {
    if (S.tab !== 'explore') return;
    if (!S.chart) addChart('bar');
    placeAuto(field);
  });
}
