// Data tab: column profile + paged row preview.
import { S, h, clear, $, api, on, emit, toast, makePill, fmtCell, fmtInt } from './core.js';
import { KIND_GLYPH, renderFields } from './fields.js';
import { renderFilters } from './filters.js';

const PAGE = 100;
let offset = 0;

const TYPES = [['text', 'Text'], ['integer', 'Whole number'], ['decimal', 'Decimal number'], ['date', 'Date'], ['datetime', 'Date & time'], ['boolean', 'True / False']];

function typeKey(dtype) {
  const d = dtype.toUpperCase();
  if (d.startsWith('VARCHAR')) return 'text';
  if (/^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?)$/.test(d)) return 'integer';
  if (d === 'DOUBLE' || d === 'FLOAT' || d === 'REAL' || d.startsWith('DECIMAL')) return 'decimal';
  if (d === 'DATE') return 'date';
  if (d.startsWith('TIMESTAMP')) return 'datetime';
  if (d === 'BOOLEAN') return 'boolean';
  return null;
}

/** Dropdown to override the detected type (e.g. an ID read as a number → Text, "revenue" read as text → Decimal). */
function typeSelect(c) {
  const cur = typeKey(c.dtype);
  if (c.kind === 'other') return h('span', { class: 'muted' }, c.dtype);
  const sel = h('select', { class: 'type-sel', title: `Detected as ${c.dtype}. Change it if it was guessed wrong.` },
    cur ? null : h('option', { value: '', selected: true, disabled: true }, c.dtype),
    ...TYPES.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
  sel.addEventListener('change', () => changeType(c, sel.value, sel, cur));
  return sel;
}

async function changeType(c, target, sel, prev) {
  const label = TYPES.find(t => t[0] === target)[1];
  try {
    let r = await api('/api/set_type', { column: c.name, type: target });
    if (r.needs_confirm) {
      const ex = r.examples.map(x => `"${x}"`).join(', ');
      const ok = confirm(`${fmtInt(r.failed)} of ${fmtInt(r.total)} values in "${c.name}" can't be read as ${label}` +
        ` (for example ${ex}).\nThey would become empty.\n\nConvert anyway?`);
      if (!ok) { sel.value = prev || ''; return; }
      r = await api('/api/set_type', { column: c.name, type: target, force: true });
    }
    S.meta = r.meta;
    // anything built on the old type (filters, chart pills, stats variables) is reset so nothing breaks
    S.filters = S.filters.filter(f => f.field !== c.name);
    for (const ch of S.charts) for (const k of Object.keys(ch.shelves)) if (ch.shelves[k]?.field === c.name) ch.shelves[k] = makePill(c.name, ch.mark);
    for (const a of Object.values(S.slots)) for (const k of Object.keys(a)) a[k] = a[k].filter(v => v !== c.name);
    renderFields(); renderFilters(); renderProfile(); loadPreview(true);
    emit('type-changed', c.name);
    toast(`"${c.name}" is now ${label}` + (r.failed ? ` — ${fmtInt(r.failed)} values became empty` : ''), 'info', 4000);
  } catch (e) { sel.value = prev || ''; toast(e.message); }
}

export function renderProfile() {
  const box = clear($('#profile'));
  if (!S.meta) return;
  const n = S.meta.n_rows;
  const th = (t, cls = 'r') => h('th', { class: cls }, t);
  box.append(h('table', { class: 'stat-table profile' },
    h('thead', {}, h('tr', {}, th('Column', 'l'), th('Type', 'l'), th('Non-null'), th('Missing'), th('Unique ≈'), th('Min'), th('Max'), th('Mean'), th('SD'))),
    h('tbody', {}, S.meta.columns.map(c => h('tr', {},
      h('td', { class: 'l' }, h('span', { class: `glyph k-${c.kind}` }, KIND_GLYPH[c.kind]), ' ', c.name),
      h('td', { class: 'l' }, typeSelect(c)),
      h('td', { class: 'r' }, fmtInt(c.n)),
      h('td', { class: `r ${c.nulls ? 'warn' : ''}` }, c.nulls ? `${fmtInt(c.nulls)} (${(100 * c.nulls / n).toFixed(1)}%)` : '0'),
      h('td', { class: 'r' }, c.nunique == null ? '' : fmtInt(c.nunique)),
      h('td', { class: 'r' }, c.kind === 'numeric' ? fmtCell(+c.min, 'num') : (c.min ?? '')),
      h('td', { class: 'r' }, c.kind === 'numeric' ? fmtCell(+c.max, 'num') : (c.max ?? '')),
      h('td', { class: 'r' }, fmtCell(c.mean, 'num')), h('td', { class: 'r' }, fmtCell(c.sd, 'num')))))));
}

export async function loadPreview(reset = false) {
  if (!S.meta) return;
  if (reset) offset = 0;
  const box = clear($('#rows'));
  try {
    const d = await api(`/api/preview?limit=${PAGE}&offset=${offset}`, { filters: S.filters });
    const cols = S.meta.columns.map(c => c.name);
    const to = Math.min(offset + PAGE, d.total);
    $('#pageInfo').textContent = d.total ? `Rows ${fmtInt(offset + 1)}–${fmtInt(to)} of ${fmtInt(d.total)}${S.filters.length ? ' (filtered)' : ''}` : 'No rows match the filters';
    $('#prevPage').disabled = offset === 0;
    $('#nextPage').disabled = to >= d.total;
    box.append(h('table', { class: 'stat-table rows' },
      h('thead', {}, h('tr', {}, h('th', { class: 'r idx' }, '#'), cols.map(c => h('th', { class: 'l' }, c)))),
      h('tbody', {}, d.rows.map((r, i) => h('tr', {}, h('td', { class: 'r idx' }, offset + i + 1),
        cols.map(c => { const v = r[c]; return h('td', { class: typeof v === 'number' ? 'r' : 'l' }, v === null ? h('span', { class: 'null' }, 'null') : typeof v === 'object' ? JSON.stringify(v) : String(v)); }))))));
  } catch (e) { box.append(h('div', { class: 'empty error' }, e.message)); }
}

export function initData() {
  $('#prevPage').addEventListener('click', () => { offset = Math.max(0, offset - PAGE); loadPreview(); });
  $('#nextPage').addEventListener('click', () => { offset += PAGE; loadPreview(); });
  on('filters-changed', () => S.tab === 'data' && loadPreview(true));
}
