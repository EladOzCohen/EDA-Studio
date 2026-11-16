// Left sidebar: draggable field list (dimensions / measures).
import { S, RECORDS, h, clear, $, emit } from './core.js';

export const DND = 'application/x-eda-field';
export const KIND_GLYPH = { numeric: '#', categorical: 'Aa', temporal: '◷', other: '{ }' };

export function startDrag(e, payload) {
  e.dataTransfer.setData(DND, JSON.stringify(payload));
  e.dataTransfer.setData('text/plain', payload.field);
  e.dataTransfer.effectAllowed = 'copyMove';
  document.body.classList.add('dragging');
}
export function endDrag() { document.body.classList.remove('dragging'); }
export function readDrag(e) {
  try { return JSON.parse(e.dataTransfer.getData(DND)); } catch { return null; }
}
export function hasField(e) { return [...(e.dataTransfer?.types || [])].includes(DND); }

function fieldItem(c) {
  const item = h('div', { class: `field ${c.kind}`, draggable: c.kind !== 'other', title: `${c.name}\n${c.dtype}${c.kind === 'other' ? ' (nested — not usable)' : ''}`,
    ondragstart: e => startDrag(e, { field: c.name, from: 'fields' }), ondragend: endDrag,
    ondblclick: () => emit('field-activate', c.name) },
    h('span', { class: 'glyph' }, KIND_GLYPH[c.kind]), h('span', { class: 'fname' }, c.name));
  return item;
}

export function renderFields() {
  const root = clear($('#fieldList'));
  const q = ($('#fieldSearch').value || '').toLowerCase();
  if (!S.meta) { root.append(h('div', { class: 'empty small' }, 'Open a file to see its fields')); return; }
  const cols = S.meta.columns.filter(c => c.name.toLowerCase().includes(q));
  const dims = cols.filter(c => c.kind !== 'numeric');
  const meas = cols.filter(c => c.kind === 'numeric');
  root.append(h('div', { class: 'group-title' }, `Dimensions (${dims.length})`), ...dims.map(fieldItem));
  const records = h('div', { class: 'field numeric', draggable: true, title: 'Row count', ondragstart: e => startDrag(e, { field: RECORDS, from: 'fields' }), ondragend: endDrag,
    ondblclick: () => emit('field-activate', RECORDS) }, h('span', { class: 'glyph' }, '#'), h('span', { class: 'fname' }, 'Number of Records'));
  root.append(h('div', { class: 'group-title' }, `Measures (${meas.length})`), ...meas.map(fieldItem), q && !'number of records'.includes(q) ? null : records);
}

export function initFields() {
  $('#fieldSearch').addEventListener('input', renderFields);
  // Dropping a pill on the sidebar removes it from its shelf (Tableau-style).
  const side = $('#sidebar');
  side.addEventListener('dragover', e => { if (hasField(e)) e.preventDefault(); });
  side.addEventListener('drop', e => {
    const d = readDrag(e);
    if (d && d.from && d.from !== 'fields') { e.preventDefault(); emit('pill-removed', d); }
  });
}
