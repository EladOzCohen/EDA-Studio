// Statistics tab: generic Jamovi-style form built from the backend's analysis definitions.
import { S, h, clear, $, api, on, colOf, toast, fmtCell, vegaConfig, isDark } from './core.js';
import { startDrag, endDrag, readDrag, hasField, KIND_GLYPH } from './fields.js';

let seq = 0, timer = null;
const cur = () => S.analyses.find(a => a.id === S.analysisId);
const slotsOf = () => (S.slots[S.analysisId] ||= {});
const optsOf = () => {
  const a = cur();
  const o = (S.aopts[a.id] ||= {});
  a.options.forEach(op => { if (!(op.key in o)) o[op.key] = op.default; });
  return o;
};

function accepts(slot, name) {
  const c = colOf(name);
  if (!c || c.kind === 'other') return false;
  if (slot.kinds.includes(c.kind)) return true;
  return slot.kinds.includes('categorical') && c.kind === 'numeric' && c.nunique <= 20;   // coded groups like 0/1
}

function addToSlot(slot, name) {
  if (!accepts(slot, name)) {
    toast(`'${name}' can't go into "${slot.label}" (needs ${slot.kinds.join(' / ')})`, 'info', 3500);
    return false;
  }
  const s = slotsOf();
  // a variable can live in only one slot of an analysis
  for (const k of Object.keys(s)) s[k] = (s[k] || []).filter(v => v !== name);
  s[slot.key] = slot.multiple ? [...(s[slot.key] || []), name] : [name];
  return true;
}

export function renderStatsForm() {
  const root = clear($('#statsForm'));
  if (!S.analyses.length) return;
  const a = cur();
  const picker = h('select', { class: 'analysis-select', onchange: e => { S.analysisId = e.target.value; renderStatsForm(); scheduleRun(); } });
  const groups = [...new Set(S.analyses.map(x => x.group))];
  groups.forEach(g => picker.append(h('optgroup', { label: g }, ...S.analyses.filter(x => x.group === g).map(x => h('option', { value: x.id, selected: x.id === a.id }, x.label)))));
  root.append(h('div', { class: 'form-section' }, h('div', { class: 'form-title' }, 'Analysis'), picker));

  const slotsWrap = h('div', { class: 'form-section' }, h('div', { class: 'form-title' }, 'Variables'),
    h('div', { class: 'hint' }, 'Drag fields here from the left (or double-click a field).'));
  a.slots.forEach(slot => {
    const vals = slotsOf()[slot.key] || [];
    const zone = h('div', { class: 'slot-zone' }, vals.length ? vals.map(v => h('div', { class: 'chip', draggable: true, ondragstart: e => startDrag(e, { field: v, from: 'slot:' + slot.key }), ondragend: endDrag },
      h('span', { class: 'glyph' }, KIND_GLYPH[colOf(v)?.kind] || ''), h('span', { class: 'chip-label' }, v),
      h('button', { class: 'pill-btn', onclick: () => { slotsOf()[slot.key] = vals.filter(x => x !== v); renderStatsForm(); scheduleRun(); } }, '×')))
      : h('span', { class: 'placeholder' }, slot.multiple ? 'drop one or more' : 'drop one'));
    zone.addEventListener('dragover', e => { if (hasField(e)) { e.preventDefault(); zone.classList.add('over'); } });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', e => {
      zone.classList.remove('over');
      const d = readDrag(e);
      if (!d) return;
      e.preventDefault(); e.stopPropagation();
      if (addToSlot(slot, d.field)) { renderStatsForm(); scheduleRun(); }
    });
    slotsWrap.append(h('div', { class: 'slot' }, h('div', { class: 'slot-label' }, slot.label + (slot.required ? '' : ' (optional)')), zone));
  });
  root.append(slotsWrap);

  const o = optsOf();
  const optWrap = h('div', { class: 'form-section' }, h('div', { class: 'form-title' }, 'Options'));
  a.options.forEach(op => {
    const set = v => { o[op.key] = v; scheduleRun(); };
    if (op.type === 'checkbox') optWrap.append(h('label', { class: 'opt' }, h('input', { type: 'checkbox', checked: !!o[op.key], onchange: e => set(e.target.checked) }), op.label));
    else if (op.type === 'select') optWrap.append(h('label', { class: 'opt col' }, op.label, h('select', { onchange: e => set(e.target.value) },
      ...op.choices.map(c => h('option', { value: c.value, selected: c.value === o[op.key] }, c.label)))));
    else optWrap.append(h('label', { class: 'opt col' }, op.label, h('input', { type: 'number', step: op.step || 'any', value: o[op.key], onchange: e => set(e.target.value === '' ? null : +e.target.value) })));
  });
  root.append(optWrap);
}

export function scheduleRun() { clearTimeout(timer); timer = setTimeout(runAnalysis, 350); }

export async function runAnalysis() {
  const out = clear($('#statsResults'));
  if (!S.meta) return;
  const a = cur();
  const slots = slotsOf();
  const missing = a.slots.filter(s => s.required && !(slots[s.key] || []).length);
  if (missing.length) {
    out.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, a.label), h('div', {}, `Add: ${missing.map(m => m.label).join(', ')}`)));
    return;
  }
  const my = ++seq;
  out.append(h('div', { class: 'empty' }, 'Computing…'));
  try {
    const { blocks } = await api('/api/analyze', { id: a.id, slots, options: optsOf(), filters: S.filters });
    if (my !== seq) return;
    clear(out).append(...blocks.map(renderBlock));
  } catch (e) {
    if (my !== seq) return;
    clear(out).append(h('div', { class: 'empty error' }, h('div', { class: 'big' }, 'Can’t run this analysis yet'), h('div', {}, e.message)));
  }
}

function renderBlock(b) {
  if (b.type === 'note') return h('div', { class: `note ${b.level}` }, b.text);
  if (b.type === 'chart') {
    const host = h('div', { class: 'vega-host stat-chart' });
    const spec = { ...b.spec };
    if (!spec.width && !spec.facet) spec.width = 460;
    if (!spec.height && !spec.facet) spec.height = 280;
    queueMicrotask(() => window.vegaEmbed(host, spec, { mode: 'vega-lite', actions: { export: true, source: false, compiled: false, editor: false }, config: vegaConfig(),
      tooltip: { theme: isDark() ? 'dark' : 'light' } }).catch(err => host.append(h('div', { class: 'note error' }, String(err.message || err)))));
    return h('section', { class: 'block' }, h('h3', {}, b.title), host);
  }
  const cols = b.columns;
  const tbl = h('table', { class: 'stat-table' },
    h('thead', {}, h('tr', {}, cols.map(c => h('th', { class: c.fmt === 'text' ? 'l' : 'r' }, c.label)))),
    h('tbody', {}, b.rows.map(r => h('tr', {}, cols.map(c => {
      const v = r[c.key];
      return h('td', { class: `${c.fmt === 'text' ? 'l' : 'r'} ${c.fmt === 'p' && v !== null && v < 0.05 ? 'sig' : ''}` }, fmtCell(v, c.fmt));
    })))));
  const copy = h('button', { class: 'link', title: 'Copy as tab-separated text (paste into Excel)', onclick: async () => {
    const tsv = [cols.map(c => c.label).join('\t'), ...b.rows.map(r => cols.map(c => fmtCell(r[c.key], c.fmt)).join('\t'))].join('\n');
    try { await navigator.clipboard.writeText(tsv); toast('Table copied', 'info', 1800); } catch { toast('Copy failed'); }
  } }, 'Copy');
  return h('section', { class: 'block' }, h('div', { class: 'block-head' }, h('h3', {}, b.title), copy), h('div', { class: 'table-wrap' }, tbl), b.note ? h('p', { class: 'tnote' }, b.note) : null);
}

export async function initStats() {
  S.analyses = await api('/api/analyses');
  on('filters-changed', () => S.tab === 'stats' && scheduleRun());
  on('field-activate', name => {
    if (S.tab !== 'stats') return;
    const a = cur();
    const s = slotsOf();
    const target = a.slots.find(sl => accepts(sl, name) && (sl.multiple || !(s[sl.key] || []).length)) || a.slots.find(sl => accepts(sl, name));
    if (!target) return toast(`'${name}' doesn't fit any variable box in this analysis`, 'info', 3500);
    if (addToSlot(target, name)) { renderStatsForm(); scheduleRun(); }
  });
  on('pill-removed', () => {});
}
