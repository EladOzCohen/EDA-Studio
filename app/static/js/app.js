import { S, h, clear, $, api, on, emit, toast, fmtInt } from './core.js';
import { initFields, renderFields } from './fields.js';
import { initShelves, renderShelves } from './shelves.js';
import { initFilters, renderFilters } from './filters.js';
import { initChart, scheduleChart, draw } from './chart.js';
import { initStats, renderStatsForm, runAnalysis } from './stats.js';
import { initData, renderProfile, loadPreview } from './data.js';

function busy(msg) { $('#loading').hidden = !msg; $('#loadingMsg').textContent = msg || ''; }

async function guarded(fn, msg) {
  busy(msg);
  try { return await fn(); } catch (e) { toast(e.message); } finally { busy(null); }
}

function setDataset(meta) {
  S.meta = meta;
  for (const k of Object.keys(S.shelves)) S.shelves[k] = null;
  S.filters = [];
  S.slots = {};
  S.aopts = {};
  $('#welcome').hidden = true;
  $('#dsName').textContent = meta.name;
  $('#dsInfo').textContent = `${fmtInt(meta.n_rows)} rows · ${meta.columns.length} columns`;
  const sheet = $('#sheetSel');
  sheet.hidden = !(meta.sheets && meta.sheets.length > 1);
  if (!sheet.hidden) { clear(sheet).append(...meta.sheets.map(s => h('option', { value: s, selected: s === meta.sheet }, s))); }
  renderFields(); renderShelves(); renderFilters();
  showTab(S.tab);
}

export function showTab(tab) {
  S.tab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-pane').forEach(p => (p.hidden = p.id !== 'tab-' + tab));
  if (!S.meta) return;
  if (tab === 'explore') { renderShelves(); scheduleChart(); requestAnimationFrame(draw); }
  if (tab === 'stats') { renderStatsForm(); runAnalysis(); }
  if (tab === 'data') { renderProfile(); loadPreview(true); }
}

const openPath = (path, sheet) => guarded(async () => setDataset(await api('/api/load', { path, sheet })), 'Loading data…');

async function pickAndOpen() {
  const { path } = await api('/api/pick_file', {});
  if (path) await openPath(path);
}

async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  await guarded(async () => {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    setDataset(data);
  }, `Loading ${file.name}…`);
}

async function main() {
  initFields(); initShelves(); initFilters(); initChart(); initData();
  await initStats();

  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#openBtn').addEventListener('click', () => guarded(pickAndOpen));
  $('#welcomeOpen').addEventListener('click', () => guarded(pickAndOpen));
  $('#pathGo').addEventListener('click', () => { const p = $('#pathIn').value.trim().replace(/^"|"$/g, ''); if (p) openPath(p); });
  $('#pathIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('#pathGo').click(); });
  $('#sheetSel').addEventListener('change', e => openPath(S.meta.path, e.target.value));

  on('shelves-changed', renderShelves);

  // drag a file from Explorer onto the window
  let depth = 0;
  const isFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', e => { if (isFiles(e)) { depth++; $('#dropOverlay').hidden = false; } });
  addEventListener('dragleave', e => { if (isFiles(e) && --depth <= 0) { depth = 0; $('#dropOverlay').hidden = true; } });
  addEventListener('dragover', e => { if (isFiles(e)) e.preventDefault(); });
  addEventListener('drop', e => { if (!isFiles(e)) return; e.preventDefault(); depth = 0; $('#dropOverlay').hidden = true; if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]); });
  addEventListener('dragend', () => document.body.classList.remove('dragging'));

  // sample datasets on the welcome screen
  try {
    const samples = await api('/api/samples');
    const box = $('#samples');
    samples.forEach(s => box.append(h('button', { class: 'btn', onclick: () => openPath(s.path) }, s.name)));
    if (!samples.length) $('#samplesRow').hidden = true;
  } catch { $('#samplesRow').hidden = true; }

  const st = await api('/api/state');
  if (st) setDataset(st);
  else { $('#welcome').hidden = false; renderFields(); }
}

main().catch(e => { console.error(e); toast(String(e.message || e)); });
