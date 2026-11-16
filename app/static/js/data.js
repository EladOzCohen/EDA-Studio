// Data tab: column profile + paged row preview.
import { S, h, clear, $, api, on, fmtCell, fmtInt } from './core.js';
import { KIND_GLYPH } from './fields.js';

const PAGE = 100;
let offset = 0;

export function renderProfile() {
  const box = clear($('#profile'));
  if (!S.meta) return;
  const n = S.meta.n_rows;
  const th = (t, cls = 'r') => h('th', { class: cls }, t);
  box.append(h('table', { class: 'stat-table profile' },
    h('thead', {}, h('tr', {}, th('Column', 'l'), th('Type', 'l'), th('Non-null'), th('Missing'), th('Unique ≈'), th('Min'), th('Max'), th('Mean'), th('SD'))),
    h('tbody', {}, S.meta.columns.map(c => h('tr', {},
      h('td', { class: 'l' }, h('span', { class: `glyph k-${c.kind}` }, KIND_GLYPH[c.kind]), ' ', c.name),
      h('td', { class: 'l muted' }, c.dtype),
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
