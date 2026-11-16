// Global filter bar (applies to charts, stats and the data table).
import { S, RECORDS, h, clear, $, api, emit, colOf, openPopover, closePopover, toast, fmtInt } from './core.js';
import { readDrag, hasField } from './fields.js';

const changed = () => { renderFilters(); emit('filters-changed'); };

function summary(f) {
  if (f.kind === 'range') {
    const a = f.min ?? '…', b = f.max ?? '…';
    return `${f.field}: ${a} → ${b}`;
  }
  const n = f.values.length;
  const shown = f.values.slice(0, 2).join(', ') + (n > 2 ? ` +${n - 2}` : '');
  return `${f.field} ${f.exclude ? '≠' : '='} ${n ? shown : '(none)'}`;
}

export function renderFilters() {
  const box = clear($('#filterPills'));
  S.filters.forEach((f, i) => {
    const pill = h('div', { class: 'pill filter', title: summary(f) },
      h('span', { class: 'pill-label' }, summary(f)),
      h('button', { class: 'pill-btn', title: 'Remove filter', onclick: e => { e.stopPropagation(); S.filters.splice(i, 1); changed(); } }, '×'));
    pill.addEventListener('click', () => editFilter(pill, i));
    box.append(pill);
  });
  $('#filterHint').hidden = S.filters.length > 0 || !S.meta;
  $('#filterBar').classList.toggle('has', S.filters.length > 0);
}

export async function addFilter(field, anchor) {
  if (!S.meta || field === RECORDS) return;
  const c = colOf(field);
  if (c.kind === 'other') return toast('Nested columns cannot be filtered');
  const f = c.kind === 'categorical' ? { field, kind: 'in', values: [], exclude: false } : { field, kind: 'range', min: null, max: null };
  S.filters.push(f);
  renderFilters();
  const pillEl = $('#filterPills').lastElementChild;
  await editFilter(pillEl || anchor, S.filters.length - 1, true);
}

async function editFilter(anchor, idx, isNew = false) {
  const f = S.filters[idx];
  const c = colOf(f.field);
  const draft = JSON.parse(JSON.stringify(f));
  const body = h('div', { class: 'menu filter-editor' }, h('div', { class: 'menu-title' }, f.field));
  const finish = apply => {
    if (apply) {
      if (draft.kind === 'range' && draft.min === null && draft.max === null) S.filters.splice(idx, 1);
      else S.filters[idx] = draft;
      changed();
    } else if (isNew) { S.filters.splice(idx, 1); changed(); }
    closePopover();
  };
  let applied = false;
  const pop = openPopover(anchor, body, { width: 300, onClose: () => { if (!applied && isNew && S.filters[idx] === f) { S.filters.splice(idx, 1); renderFilters(); emit('filters-changed'); } } });
  const done = apply => { applied = true; finish(apply); };

  if (draft.kind === 'range') {
    const info = await api('/api/distinct', { field: f.field, filters: S.filters.filter((_, i) => i !== idx) });
    const mk = (key, label) => h('label', { class: 'frow' }, label, h('input', { type: 'text', value: draft[key] ?? '', placeholder: key === 'min' ? info.min : info.max,
      oninput: e => { draft[key] = e.target.value.trim() === '' ? null : e.target.value.trim(); } }));
    body.append(h('div', { class: 'hint' }, `Data range: ${info.min} → ${info.max}${c.kind === 'temporal' ? ' (YYYY-MM-DD)' : ''}`), mk('min', 'From'), mk('max', 'To'));
  } else {
    const info = await api('/api/distinct', { field: f.field, filters: S.filters.filter((_, i) => i !== idx) });
    const all = info.values.map(v => v.value);
    const complete = info.nunique <= all.length;
    if (isNew && complete) draft.values = [...all];                 // start with everything kept
    if (isNew && !complete) draft.exclude = true;                    // big domain: start by excluding nothing
    const sel = new Set(draft.values);
    const list = h('div', { class: 'checklist' });
    const modeSeg = h('div', { class: 'seg' },
      h('button', { class: !draft.exclude ? 'on' : '', onclick: () => setMode(false) }, 'Keep selected'),
      h('button', { class: draft.exclude ? 'on' : '', onclick: () => setMode(true) }, 'Exclude selected'));
    const setMode = ex => { draft.exclude = ex; [...modeSeg.children].forEach((b, i) => b.classList.toggle('on', (i === 1) === ex)); };
    const draw = rows => {
      clear(list);
      rows.forEach(v => list.append(h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: sel.has(v.value), onchange: e => { e.target.checked ? sel.add(v.value) : sel.delete(v.value); draft.values = [...sel]; } }),
        h('span', { class: 'cv' }, v.value ?? '(null)'), h('span', { class: 'cn' }, fmtInt(v.n)))));
    };
    draw(info.values);
    let t;
    const search = h('input', { type: 'search', placeholder: complete ? 'Search values…' : `Search (showing top ${all.length} of ~${fmtInt(info.nunique)})…`, oninput: e => {
      clearTimeout(t); t = setTimeout(async () => draw((await api('/api/distinct', { field: f.field, search: e.target.value, filters: S.filters.filter((_, i) => i !== idx) })).values), 200); } });
    const quick = h('div', { class: 'menu-row' },
      h('button', { class: 'link', onclick: () => { info.values.forEach(v => sel.add(v.value)); draft.values = [...sel]; draw(info.values); } }, 'Select shown'),
      h('button', { class: 'link', onclick: () => { sel.clear(); draft.values = []; draw(info.values); } }, 'Clear'));
    body.append(modeSeg, search, quick, list);
  }
  body.append(h('div', { class: 'menu-row end' },
    h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: () => done(true) }, 'Apply')));
  void pop;
}

export function initFilters() {
  const bar = $('#filterBar');
  bar.addEventListener('dragover', e => { if (hasField(e)) { e.preventDefault(); bar.classList.add('over'); } });
  bar.addEventListener('dragleave', () => bar.classList.remove('over'));
  bar.addEventListener('drop', e => {
    bar.classList.remove('over');
    const d = readDrag(e);
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    if (d.from !== 'fields') return;
    addFilter(d.field, bar);
  });
}
