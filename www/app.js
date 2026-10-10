/* Day Care Chemo Summary — mobile interface.
   Same data model, same local storage and same Google Sheet columns as the desktop app. */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : (iso || ''); };

const AE_OPTIONS = ['No adverse event / well tolerated', 'Nausea', 'Vomiting', 'Hypersensitivity reaction', 'Extravasation', 'Chills/rigors', 'Other (see notes)'];
const DEFAULT_ADVICE = `1. Adequate oral hydration.
2. Continue home medications as prescribed.
3. Report immediately for fever >100.4°F, uncontrolled vomiting, loose stools, bleeding, or breathlessness.
4. Review CBC and Serum Creatinine prior to next cycle.`;

const LISTS = {
  premeds: { box: '#lstPre', fields: [['drug', 'Drug', 'text'], ['dose', 'Dose', 'text', 'half'], ['route', 'Route', 'text', 'half']] },
  chemo: { box: '#lstChemo', fields: [['drug', 'Drug', 'text'], ['dose', 'Dose', 'text', 'half'], ['route', 'Route', 'text', 'half'], ['diluent', 'Diluent / volume', 'text', 'half'], ['duration', 'Infusion duration', 'text', 'half']] },
  postmeds: { box: '#lstPost', fields: [['drug', 'Drug', 'text'], ['dose', 'Dose', 'text', 'half'], ['route', 'Frequency / route', 'text', 'half'], ['duration', 'Duration', 'text']] },
};

let CFG = { premeds: [], postmeds: [], consultants: [], logoDataUri: null };
const S = { rec: null, origKey: null, origSavedAt: null, dirty: false, stack: ['scrHome'], patientUhid: null, patient: null, index: [] };
let T = null; // settings working copy
let _logoCache = null;

/* ---------- small UI helpers ---------- */
let _toastTimer = null;
function toast(msg, kind = 'ok', ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show ' + kind;
  clearTimeout(_toastTimer); _toastTimer = setTimeout(() => { t.className = ''; }, ms);
}
function busy(on) { $('#busy').classList.toggle('show', !!on); }
function ask(title, msg, buttons) {
  return new Promise(resolve => {
    const box = $('#askBox');
    box.innerHTML = `<h3>${esc(title)}</h3><p>${esc(msg)}</p>` +
      buttons.map((b, i) => `<button class="btn ${b.cls || 'ghost'}" data-i="${i}">${esc(b.label)}</button>`).join('');
    $('#overlayAsk').classList.add('show');
    box.onclick = e => {
      const b = e.target.closest('button[data-i]'); if (!b) return;
      $('#overlayAsk').classList.remove('show'); box.onclick = null; resolve(buttons[+b.dataset.i].value);
    };
  });
}

/* ---------- navigation ---------- */
function show(id) { $$('.screen').forEach(s => s.classList.toggle('active', s.id === id)); window.scrollTo(0, 0); }
function go(id) { S.stack.push(id); show(id); }
async function back() {
  const cur = S.stack[S.stack.length - 1];
  if (cur === 'scrHome') { try { const A = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App; if (A) A.exitApp(); } catch (e) {} return; }
  if (cur === 'scrEdit' && S.dirty && S.rec.uhid && S.rec.uhid.trim()) {
    const c = await ask('Unsaved changes', 'Save this visit before leaving?', [
      { label: 'Save', cls: 'primary', value: 'save' }, { label: 'Discard changes', cls: 'danger', value: 'discard' }, { label: 'Keep editing', cls: 'ghost', value: 'stay' }]);
    if (c === 'stay') return;
    if (c === 'save') { const ok = await save(); if (!ok) return; }
  } else if (cur === 'scrEdit' && S.dirty) {
    const c = await ask('Discard this entry?', 'Nothing is saved yet because no UHID was entered.', [
      { label: 'Discard', cls: 'danger', value: 'discard' }, { label: 'Keep editing', cls: 'ghost', value: 'stay' }]);
    if (c === 'stay') return;
  }
  S.stack.pop();
  const prev = S.stack[S.stack.length - 1] || 'scrHome';
  if (prev === 'scrHome') renderHome();
  if (prev === 'scrPatient') await openPatient(S.patientUhid, true);
  show(prev);
}
function jump(id) { const el = document.getElementById(id); if (el) { el.open = true; const y = el.getBoundingClientRect().top + window.scrollY - 130; window.scrollTo({ top: y, behavior: 'smooth' }); } }

/* ---------- blank / derived records ---------- */
const stdPre = () => CFG.premeds.map(a => ({ drug: a[0] || '', dose: a[1] || '', route: a[2] || '' }));
const stdPost = () => CFG.postmeds.map(a => ({ drug: a[0] || '', dose: a[1] || '', route: a[2] || '', duration: a[3] || '' }));
function blankRec(uhid) {
  return { name: '', ageSex: '', uhid: uhid || '', dx: '', consultant: '', date: todayISO(), regimen: '', cycle: '', ecog: '', hopi: '',
    bp: '', pr: '', spo2: '', temp: '', premeds: stdPre(), chemo: [{ drug: '', dose: '', route: '', diluent: '', duration: '' }], postmeds: stdPost(),
    ae: [AE_OPTIONS[0]], aeNotes: '', advice: DEFAULT_ADVICE, nextCycle: '', dischargeDate: '' };
}
const clone = o => JSON.parse(JSON.stringify(o));
function recKey(r) { return r && r.date && r.cycle ? `${r.date}|${r.cycle}` : null; }

/* ---------- HOME ---------- */
async function loadIndex() { try { S.index = (await MobileAPI.getIndex()) || []; } catch (e) { S.index = []; } }
async function renderHome() {
  await loadIndex();
  const q = ($('#q').value || '').trim().toLowerCase();
  let list = S.index.slice().reverse();
  if (q) list = list.filter(p => (p.uhid || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q));
  const box = $('#homeList');
  if (!list.length) {
    box.innerHTML = q
      ? `<div class="empty">No saved patient matches &ldquo;${esc(q)}&rdquo;.<br><br>
         <button class="btn soft sm" onclick="pullUhid()">&#8635; Look up in cloud</button>
         <button class="btn ghost sm" onclick="newVisit($('#q').value.trim())">Start new for this UHID</button></div>`
      : `<div class="empty">No patients yet.<br>Tap &ldquo;New day-care visit&rdquo; to begin.</div>`;
    return;
  }
  box.innerHTML = list.map(p => `<button class="pitem" data-u="${esc(p.uhid)}">
      <span class="avatar">${esc((p.name || p.uhid || '?').trim().charAt(0).toUpperCase())}</span>
      <span><div class="nm">${esc(p.name || '(no name)')}</div><div class="sub">UHID ${esc(p.uhid)}</div></span><span class="chev">&rsaquo;</span></button>`).join('');
  $$('.pitem', box).forEach(b => b.onclick = () => openPatient(b.dataset.u));
}
async function pullUhid() {
  const u = $('#q').value.trim(); if (!u) return;
  busy(true);
  try {
    const r = await MobileAPI.pullFromCloud(u);
    busy(false);
    if (!r.ok) { toast('Cloud: ' + r.error, 'err', 5000); return; }
    if (!r.count) { toast('No records for that UHID in the cloud sheet.', 'warn'); return; }
    toast(`Found ${r.name || 'patient'} — ${r.count} visit(s) pulled.`, 'ok');
    openPatient(u);
  } catch (e) { busy(false); toast('Could not reach the cloud.', 'err'); }
}

/* ---------- PATIENT ---------- */
async function openPatient(uhid, silent) {
  S.patientUhid = uhid;
  S.patient = await MobileAPI.getPatient(uhid);
  const p = S.patient || { uhid, name: '', records: [] };
  $('#ptTitle').textContent = p.name || 'Patient';
  $('#ptName').textContent = p.name || '(no name)';
  const n = (p.records || []).length;
  $('#ptSub').textContent = `UHID ${uhid} · ${n} visit${n === 1 ? '' : 's'} on file`;
  const box = $('#visits');
  const recs = (p.records || []).map((r, i) => ({ r, i })).reverse();
  box.innerHTML = recs.length ? recs.map(({ r, i }) => `<div class="visit">
      <div class="top"><span>${esc(r.cycle || 'Cycle n/a')}${r.regimen ? ' — ' + esc(r.regimen) : ''}</span><span>${esc(fmtDate(r.date))}</span></div>
      <div class="meta">${esc((r.ae && r.ae.length ? r.ae.join(', ') : '—'))}</div>
      <div class="btnrow"><button class="btn primary sm" data-open="${i}">Open</button><button class="btn danger sm" data-del="${i}">Delete</button></div></div>`).join('')
    : '<div class="empty">No saved visits for this patient.</div>';
  $$('[data-open]', box).forEach(b => b.onclick = () => openRecord(+b.dataset.open));
  $$('[data-del]', box).forEach(b => b.onclick = () => deleteVisit(+b.dataset.del));
  if (!silent) go('scrPatient');
}
async function deleteVisit(i) {
  const p = S.patient; const r = p && p.records && p.records[i]; if (!r) return;
  const c = await ask('Delete this visit?', `${r.cycle || 'Cycle n/a'} on ${fmtDate(r.date) || 'unknown date'} will be removed from this phone and from the cloud sheet. Other visits are not touched.`,
    [{ label: 'Delete this visit only', cls: 'danger', value: true }, { label: 'Cancel', cls: 'ghost', value: false }]);
  if (!c) return;
  busy(true);
  try {
    if (r.date && r.cycle) {
      const res = await MobileAPI.deleteCycle(S.patientUhid, r.date, r.cycle);
      if (res.cloudError) toast('Deleted here; cloud: ' + res.cloudError, 'warn', 5000);
      else toast(res.cloudDeleted ? 'Deleted (phone + cloud).' : 'Deleted from this phone.', 'ok');
    } else {
      // no date/cycle key: remove by position locally
      p.records.splice(i, 1);
      await MobileAPI.savePatient(S.patientUhid, p);
      toast('Deleted from this phone.', 'ok');
    }
  } catch (e) { toast('Could not delete.', 'err'); }
  busy(false);
  await openPatient(S.patientUhid, true);
}
async function pullCloud() {
  const u = S.patientUhid || $('#q').value.trim(); if (!u) return;
  busy(true);
  const r = await MobileAPI.pullFromCloud(u);
  busy(false);
  if (!r.ok) { toast('Cloud: ' + r.error, 'err', 5000); return; }
  toast(r.count ? `Pulled — ${r.count} visit(s) on file.` : 'Nothing found in the cloud for this UHID.', r.count ? 'ok' : 'warn');
  if (S.patientUhid) openPatient(S.patientUhid, true);
}
function openRecord(i) {
  const r = S.patient.records[i];
  S.rec = Object.assign(blankRec(S.patientUhid), clone(r)); S.rec.uhid = S.patientUhid;
  S.rec.premeds = clone(r.premeds || []); S.rec.postmeds = clone(r.postmeds || []);
  S.rec.chemo = (r.chemo && r.chemo.length) ? clone(r.chemo) : [{ drug: '', dose: '', route: '', diluent: '', duration: '' }];
  S.rec.ae = r.ae && r.ae.length ? clone(r.ae) : [AE_OPTIONS[0]];
  S.rec.advice = r.advice || DEFAULT_ADVICE;
  S.origKey = recKey(r); S.origSavedAt = r.savedAt || null; S.dirty = false;
  openEditor();
}
function newCycleFromLast() {
  const recs = (S.patient && S.patient.records) || [];
  const last = recs[recs.length - 1];
  S.rec = blankRec(S.patientUhid);
  if (last) {
    ['name', 'ageSex', 'dx', 'consultant', 'regimen', 'ecog', 'hopi', 'advice'].forEach(k => { S.rec[k] = last[k] || S.rec[k]; });
    S.rec.premeds = clone(last.premeds || []); S.rec.postmeds = clone(last.postmeds || []);
    S.rec.chemo = (last.chemo && last.chemo.length) ? clone(last.chemo) : S.rec.chemo;
  } else { S.rec.name = (S.patient && S.patient.name) || ''; }
  S.origKey = null; S.origSavedAt = null; S.dirty = true;
  openEditor();
}
function newVisit(uhid) {
  S.rec = blankRec(uhid || ''); S.origKey = null; S.origSavedAt = null; S.patientUhid = uhid || null; S.dirty = false;
  openEditor();
}

/* ---------- EDITOR ---------- */
function populateConsultants(current) {
  const sel = $('#selConsultant');
  const names = CFG.consultants.slice();
  if (current && !names.includes(current)) names.push(current);
  sel.innerHTML = '<option value="">Select consultant</option>' + names.map(n => `<option>${esc(n)}</option>`).join('');
  sel.value = current || '';
}
function openEditor() {
  const r = S.rec;
  populateConsultants(r.consultant);
  $$('#editor [data-k]').forEach(el => { if (el.id !== 'selConsultant') el.value = r[el.dataset.k] || ''; });
  $('#selConsultant').value = r.consultant || '';
  renderAE(); renderAllLists(); autosizeAll();
  $('#edTitle').firstChild.textContent = r.name ? r.name : 'New visit';
  $('#edSub').textContent = r.uhid ? 'UHID ' + r.uhid : '';
  $$('#editor details').forEach(d => d.open = true);
  go('scrEdit');
}
function bindEditor() {
  $('#editor').addEventListener('input', e => {
    const el = e.target; const k = el.dataset && el.dataset.k;
    if (k) { S.rec[k] = el.value; S.dirty = true; if (k === 'name' || k === 'uhid') { $('#edTitle').firstChild.textContent = S.rec.name || 'New visit'; $('#edSub').textContent = S.rec.uhid ? 'UHID ' + S.rec.uhid : ''; } }
    if (el.tagName === 'TEXTAREA') autosize(el);
  });
  $('#editor').addEventListener('change', e => { const el = e.target; if (el.id === 'selConsultant') { S.rec.consultant = el.value; S.dirty = true; } });
  // hide the bottom bar while the on-screen keyboard is open (detected by the viewport shrinking)
  let baseH = window.innerHeight;
  const chk = () => {
    const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    baseH = Math.max(baseH, h);
    document.body.classList.toggle('kb', h < baseH * 0.78);
  };
  window.addEventListener('resize', chk);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', chk);
}
function autosize(t) { t.style.height = 'auto'; t.style.height = Math.max(t.scrollHeight + 2, 96) + 'px'; }
function autosizeAll() { setTimeout(() => $$('#editor textarea').forEach(autosize), 30); }

function renderAE() {
  const box = $('#aePills');
  box.innerHTML = AE_OPTIONS.map(o => `<button type="button" class="pill ${S.rec.ae.includes(o) ? 'on' : ''}" data-ae="${esc(o)}">${esc(o.replace(' / well tolerated', ' / well tolerated'))}</button>`).join('');
  $$('.pill', box).forEach(b => b.onclick = () => {
    const v = b.dataset.ae; const set = new Set(S.rec.ae);
    if (set.has(v)) set.delete(v); else { set.add(v); if (v !== AE_OPTIONS[0]) set.delete(AE_OPTIONS[0]); else AE_OPTIONS.slice(1).forEach(x => set.delete(x)); }
    S.rec.ae = AE_OPTIONS.filter(x => set.has(x)); S.dirty = true; renderAE();
  });
}

/* list editor (used by both the visit editor and settings) */
function mountList(container, arr, fields, opts) {
  opts = opts || {};
  const render = () => {
    container.innerHTML = arr().map((row, i) => `<div class="med" data-i="${i}">
      <div class="mh"><b>${esc(opts.title || 'Item')} ${i + 1}</b>
        <button class="mini" data-a="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">&uarr;</button>
        <button class="mini" data-a="down" ${i === arr().length - 1 ? 'disabled' : ''} aria-label="Move down">&darr;</button>
        <button class="mini x" data-a="del" aria-label="Remove">&times;</button></div>
      ${rowFieldsHTML(row, fields)}</div>`).join('');
  };
  container.oninput = e => {
    const card = e.target.closest('.med'); if (!card || !e.target.dataset.f) return;
    arr()[+card.dataset.i][e.target.dataset.f] = e.target.value; if (opts.onChange) opts.onChange(false);
  };
  container.onclick = e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const i = +b.closest('.med').dataset.i; const a = arr();
    if (b.dataset.a === 'del') a.splice(i, 1);
    else { const j = b.dataset.a === 'up' ? i - 1 : i + 1; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; }
    render(); if (opts.onChange) opts.onChange(true);
  };
  render();
  return render;
}
function rowFieldsHTML(row, fields) {
  let out = '', pend = [];
  const flush = () => { if (pend.length) { out += `<div class="row2">${pend.join('')}</div>`; pend = []; } };
  fields.forEach(([k, label, type, half]) => {
    const html = `<div class="field"><label class="lbl">${esc(label)}</label><input type="${type || 'text'}" data-f="${k}" value="${esc(row[k] || '')}" autocomplete="off"></div>`;
    if (half) { pend.push(html); if (pend.length === 2) flush(); } else { flush(); out += html; }
  });
  flush(); return out;
}

const _renders = {};
function renderAllLists() {
  Object.keys(LISTS).forEach(kind => {
    _renders[kind] = mountList($(LISTS[kind].box), () => S.rec[kind], LISTS[kind].fields, {
      title: kind === 'chemo' ? 'Chemo drug' : 'Medication',
      onChange: structural => { S.dirty = true; if (structural) renderQuick(); },
    });
  });
  renderQuick();
}
function renderQuick() {
  const mk = (kind, boxSel, std) => {
    const have = new Set(S.rec[kind].map(r => (r.drug || '').trim().toLowerCase()));
    const items = std().filter(s => s.drug && !have.has(s.drug.trim().toLowerCase()));
    const box = $(boxSel);
    box.innerHTML = items.length ? items.map((s, i) => `<button class="qchip" data-q="${i}">&#43; ${esc(s.drug)}</button>`).join('') +
      (items.length > 1 ? `<button class="qchip" data-q="all">&#43; All standard</button>` : '') : '';
    box.onclick = e => {
      const b = e.target.closest('[data-q]'); if (!b) return;
      if (b.dataset.q === 'all') items.forEach(x => S.rec[kind].push(clone(x))); else S.rec[kind].push(clone(items[+b.dataset.q]));
      S.dirty = true; _renders[kind](); renderQuick();
    };
  };
  mk('premeds', '#quickPre', stdPre); mk('postmeds', '#quickPost', stdPost);
}
function addRow(kind) {
  S.rec[kind].push(kind === 'chemo' ? { drug: '', dose: '', route: '', diluent: '', duration: '' } : kind === 'postmeds' ? { drug: '', dose: '', route: '', duration: '' } : { drug: '', dose: '', route: '' });
  S.dirty = true; _renders[kind](); renderQuick();
  const cards = $$('.med', $(LISTS[kind].box)); const last = cards[cards.length - 1]; if (last) { last.scrollIntoView({ block: 'center', behavior: 'smooth' }); const i = last.querySelector('input'); if (i) i.focus(); }
}
async function clearList(kind) {
  if (!S.rec[kind].length) return;
  const c = await ask('Remove all?', kind === 'premeds' ? 'Remove every pre-medication from this visit?' : 'Remove every post-medication from this visit?',
    [{ label: 'Remove all', cls: 'danger', value: true }, { label: 'Cancel', cls: 'ghost', value: false }]);
  if (!c) return; S.rec[kind] = []; S.dirty = true; _renders[kind](); renderQuick();
}

/* ---------- SAVE ---------- */
let _saving = false;
async function save() {
  const r = S.rec; const uhid = (r.uhid || '').trim();
  if (!uhid) { toast('Enter the UHID before saving.', 'warn'); jump('sPatient'); return false; }
  if (_saving) { toast('Still saving — one moment.', 'warn'); return false; }
  _saving = true;
  try {
    let patient = (await MobileAPI.getPatient(uhid)) || { uhid, name: '', records: [] };
    patient.records = patient.records || [];
    const entry = Object.assign({}, clone(r), { uhid, savedAt: new Date().toISOString() });
    entry.premeds = entry.premeds.filter(x => x.drug || x.dose || x.route);
    entry.chemo = entry.chemo.filter(x => x.drug || x.dose);
    entry.postmeds = entry.postmeds.filter(x => x.drug || x.dose);
    patient.name = r.name || patient.name;
    let idx = -1;
    if (S.origSavedAt) idx = patient.records.findIndex(x => x.savedAt === S.origSavedAt);
    if (idx < 0 && recKey(entry)) idx = patient.records.findIndex(x => recKey(x) === recKey(entry));
    if (idx > -1) patient.records[idx] = entry; else patient.records.push(entry);
    const res = await MobileAPI.savePatient(uhid, patient);
    // if the date/cycle was edited, retire the old cloud row so the sheet has no stale copy
    if (S.origKey && S.origKey !== recKey(entry)) {
      const [od, oc] = S.origKey.split('|');
      try { await MobileAPI.deleteCycle(uhid, od, oc); } catch (e) {}
      // deleteCycle also edits the local file; make sure our record is still present
      const again = (await MobileAPI.getPatient(uhid)) || patient;
      if (!again.records.some(x => x.savedAt === entry.savedAt)) { again.records.push(entry); await MobileAPI.savePatient(uhid, again); }
    }
    S.origKey = recKey(entry); S.origSavedAt = entry.savedAt; S.patientUhid = uhid; S.dirty = false;
    if (res && res.cloudSynced) toast('Saved on phone and synced to cloud ✓', 'ok');
    else if (res && res.cloudError) toast('Saved on phone. Cloud sync failed: ' + res.cloudError, 'warn', 6000);
    else toast('Saved on phone. (Cloud sync not set up)', 'ok');
    setDot(res && res.cloudSynced ? 'ok' : (res && res.cloudError ? 'bad' : null));
    return true;
  } catch (e) { console.error(e); toast('Could not save — ' + (e.message || e), 'err', 6000); return false; }
  finally { _saving = false; }
}
async function saveNow() { busy(true); await save(); busy(false); }

/* ---------- OUTPUT ---------- */
function openOutput() { $('#overlayOut').classList.add('show'); }
function closeOutput() { $('#overlayOut').classList.remove('show'); }
async function logoSrc() {
  if (CFG.logoDataUri) return CFG.logoDataUri;
  if (_logoCache) return _logoCache;
  try {
    const blob = await (await fetch('assets/letterhead.png')).blob();
    _logoCache = await new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(blob); });
  } catch (e) { _logoCache = ''; }
  return _logoCache;
}
function cleanRec() {
  const r = clone(S.rec);
  r.premeds = r.premeds.filter(x => x.drug || x.dose || x.route);
  r.chemo = r.chemo.filter(x => x.drug || x.dose);
  r.postmeds = r.postmeds.filter(x => x.drug || x.dose);
  return r;
}
function sheetHTML(r, logo) {
  const v = x => esc(x) || '&mdash;';
  const unit = (x, u) => x ? `${esc(x)}<span style="margin-left:1px">${u}</span>` : '&mdash;';
  const cell = (l, val) => `<td style="width:33.3%;vertical-align:top;padding:2px 8px 5px 0"><div style="font-size:9.5px;color:#666">${l}</div><div style="font-size:13px">${val}</div></td>`;
  const sec = t => `<div style="font-size:11.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:#0b5f66;border-bottom:1px solid #9bbcbf;margin:9px 0 4px;padding-bottom:1px">${t}</div>`;
  const tbl = (heads, rows, cols) => `<table style="width:100%;border-collapse:collapse;font-size:12.5px"><tr>${heads.map(h => `<th style="border:1px solid #bbb;background:#eef4f4;text-align:left;padding:2px 6px;font-size:10.5px">${h}</th>`).join('')}</tr>` +
    rows.map(x => `<tr>${cols.map(c => `<td style="border:1px solid #bbb;padding:2px 6px">${v(x[c])}</td>`).join('')}</tr>`).join('') + '</table>';
  const gen = fmtDate(todayISO());
  return `<div style="font-family:'Times New Roman',Times,serif;color:#111;padding:22px 34px 26px;background:#fff;width:794px;line-height:1.25">
    ${logo ? `<img src="${logo}" style="display:block;margin:0 auto;max-width:100%;max-height:96px;width:auto">` : ''}
    <div style="text-align:center;font-weight:700;font-size:17px;letter-spacing:.7px;text-decoration:underline;text-transform:uppercase;color:#093f45;margin-top:4px">Discharge Summary</div>
    <div style="text-align:right;font-size:10px;color:#555">Summary generated: ${gen}</div>
    ${sec('Patient details')}
    <table style="width:100%;border-collapse:collapse"><tr>${cell('Patient name', v(r.name))}${cell('Age / Sex', v(r.ageSex))}${cell('UHID / MRN', v(r.uhid))}</tr>
      <tr>${cell('Diagnosis', v(r.dx))}${cell('Consultant', v(r.consultant))}${cell('Date', v(fmtDate(r.date)))}</tr>
      <tr>${cell('Regimen', v(r.regimen))}${cell('Cycle / Day', v(r.cycle))}${cell('ECOG PS', v(r.ecog))}</tr></table>
    ${sec('History of present illness')}
    <div style="font-size:13px;white-space:pre-wrap">${v(r.hopi)}</div>
    ${sec('Vitals')}
    <table style="width:100%;border-collapse:collapse"><tr>${[['BP', unit(r.bp, 'mmHg')], ['Pulse', unit(r.pr, '/min')], ['SpO&#8322;', unit(r.spo2, '%')], ['Temp', unit(r.temp, '&deg;F')]]
      .map(([l, val]) => `<td style="width:25%;padding:1px 8px 2px 0;font-size:13px"><span style="font-size:9.5px;color:#666">${l}&nbsp;</span> ${val}</td>`).join('')}</tr></table>
    ${r.premeds.length ? sec('Pre-medication') + tbl(['Drug', 'Dose', 'Route'], r.premeds, ['drug', 'dose', 'route']) : ''}
    ${sec('Chemotherapy administered')}
    ${tbl(['Drug', 'Dose', 'Route', 'Diluent / Vol.', 'Infusion duration'], r.chemo.length ? r.chemo : [{}], ['drug', 'dose', 'route', 'diluent', 'duration'])}
    ${r.postmeds.length ? sec('Post-medication') + tbl(['Drug', 'Dose', 'Frequency / Route', 'Duration'], r.postmeds, ['drug', 'dose', 'route', 'duration']) : ''}
    ${sec('Tolerance during infusion')}
    <div style="font-size:13px">${v((r.ae || []).join(', '))}</div>
    ${r.aeNotes ? `<div style="font-size:13px;white-space:pre-wrap;margin-top:2px">${esc(r.aeNotes)}</div>` : ''}
    ${sec('Discharge advice')}
    <div style="font-size:13px;white-space:pre-wrap">${v(r.advice)}</div>
    <table style="width:100%;border-collapse:collapse;margin-top:4px"><tr>${cell('Date of discharge', v(fmtDate(r.dischargeDate)))}${cell('Next review date', v(fmtDate(r.nextCycle)))}<td></td></tr></table>
    <table style="width:100%;margin-top:26px"><tr><td style="width:45%;border-top:1px solid #333;padding-top:2px;font-size:10px">Staff nurse signature</td><td></td><td style="width:45%;border-top:1px solid #333;padding-top:2px;font-size:10px">Treating physician signature &amp; stamp</td></tr></table>
  </div>`;
}
async function outPdf() {
  closeOutput(); busy(true);
  try {
    if (S.rec.uhid && S.rec.uhid.trim()) { await save(); }
    const logo = await logoSrc();
    const root = $('#printRoot'); root.innerHTML = sheetHTML(cleanRec(), logo);
    const img = root.querySelector('img'); if (img && !img.complete) await new Promise(r => { img.onload = r; img.onerror = r; });
    const canvas = await html2canvas(root.firstElementChild, { scale: 2, backgroundColor: '#fff', useCORS: true });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight(), m = 14;
    const ratio = Math.min((pw - 2 * m) / canvas.width, (ph - 2 * m) / canvas.height);
    const w = canvas.width * ratio, h = canvas.height * ratio;
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.93), 'JPEG', (pw - w) / 2, m, w, h);
    const b64 = pdf.output('datauristring').split(',')[1];
    const { Filesystem, Share } = window.Capacitor.Plugins;
    const fname = `DayCare_Summary_${(S.rec.name || 'patient').replace(/[^a-z0-9]/gi, '_')}.pdf`;
    await Filesystem.writeFile({ path: `exports/${fname}`, data: b64, directory: 'CACHE', recursive: true });
    const uri = await Filesystem.getUri({ path: `exports/${fname}`, directory: 'CACHE' });
    busy(false);
    await Share.share({ title: fname, url: uri.uri });
  } catch (e) { busy(false); if (!/cancel/i.test(String(e && e.message))) { console.error(e); toast('Could not create the PDF: ' + (e.message || e), 'err', 6000); } }
  finally { $('#printRoot').innerHTML = ''; busy(false); }
}
async function outWord() {
  closeOutput(); busy(true);
  try {
    if (S.rec.uhid && S.rec.uhid.trim()) { await save(); }
    const r = cleanRec(); const logo = await logoSrc();
    const V = x => esc(x) || '&mdash;'; const U = (x, u) => x ? `${esc(x)} ${u}` : '&mdash;';
    const rows = (list, cols) => list.map(x => '<tr>' + cols.map(c => `<td style="border:1px solid #ccc;padding:5px 8px;">${V(x[c])}</td>`).join('') + '</tr>').join('');
    const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset="utf-8"><title>Day Care Summary</title>
<style>body{font-family:'Times New Roman',serif;color:#1c2b2e}h2{font-size:12pt;color:#0b5f66;text-transform:uppercase;border-bottom:1px solid #0b5f66;margin-top:16px}table{border-collapse:collapse;width:100%;margin-top:6px}th{background:#eef4f4;text-align:left;padding:5px 8px;border:1px solid #ccc;font-size:10pt}td{padding:4px 8px;font-size:11pt}.grid td{width:33%;vertical-align:top}.lbl{font-size:9pt;color:#5b6b6d;display:block}</style></head><body>
${logo ? `<img src="${logo}" style="width:100%;max-width:720px;display:block">` : ''}
<p style="text-align:center;font-weight:bold;font-size:14pt;text-decoration:underline;margin:4px 0">DISCHARGE SUMMARY</p>
<h2>Patient Details</h2><table class="grid"><tr><td><span class="lbl">Patient Name</span>${V(r.name)}</td><td><span class="lbl">Age / Sex</span>${V(r.ageSex)}</td><td><span class="lbl">UHID / MRN</span>${V(r.uhid)}</td></tr>
<tr><td><span class="lbl">Diagnosis</span>${V(r.dx)}</td><td><span class="lbl">Consultant</span>${V(r.consultant)}</td><td><span class="lbl">Date</span>${V(fmtDate(r.date))}</td></tr>
<tr><td><span class="lbl">Regimen</span>${V(r.regimen)}</td><td><span class="lbl">Cycle / Day</span>${V(r.cycle)}</td><td><span class="lbl">ECOG PS</span>${V(r.ecog)}</td></tr></table>
<h2>History of Present Illness</h2><p>${V(r.hopi).replace(/\n/g, '<br>')}</p>
<h2>Vitals</h2><table class="grid"><tr><td><span class="lbl">Blood Pressure</span>${U(r.bp, 'mmHg')}</td><td><span class="lbl">Pulse Rate</span>${U(r.pr, '/min')}</td><td><span class="lbl">SpO2</span>${U(r.spo2, '%')}</td><td><span class="lbl">Temperature</span>${U(r.temp, '&deg;F')}</td></tr></table>
${r.premeds.length ? `<h2>Pre-medication</h2><table><tr><th>Drug</th><th>Dose</th><th>Route</th></tr>${rows(r.premeds, ['drug', 'dose', 'route'])}</table>` : ''}
<h2>Chemotherapy Administered</h2><table><tr><th>Drug</th><th>Dose</th><th>Route</th><th>Diluent/Vol.</th><th>Infusion duration</th></tr>${rows(r.chemo.length ? r.chemo : [{}], ['drug', 'dose', 'route', 'diluent', 'duration'])}</table>
${r.postmeds.length ? `<h2>Post-medication</h2><table><tr><th>Drug</th><th>Dose</th><th>Frequency / Route</th><th>Duration</th></tr>${rows(r.postmeds, ['drug', 'dose', 'route', 'duration'])}</table>` : ''}
<h2>Tolerance During Infusion</h2><p>${V((r.ae || []).join(', '))}</p><p>${esc(r.aeNotes).replace(/\n/g, '<br>')}</p>
<h2>Discharge Advice</h2><p>${V(r.advice).replace(/\n/g, '<br>')}</p>
<table class="grid"><tr><td><span class="lbl">Date of Discharge</span>${V(fmtDate(r.dischargeDate))}</td><td><span class="lbl">Next review date</span>${V(fmtDate(r.nextCycle))}</td><td></td></tr></table>
<br><br><table class="grid"><tr><td>_______________________<br>Staff nurse signature</td><td></td><td>_______________________<br>Physician signature &amp; stamp</td></tr></table></body></html>`;
    const res = await MobileAPI.saveWordDoc(html, `DayCare_Summary_${(r.name || 'patient').replace(/[^a-z0-9]/gi, '_')}.doc`);
    busy(false); if (!res.ok) toast('Could not create the Word file.', 'err');
  } catch (e) { busy(false); if (!/cancel/i.test(String(e && e.message))) toast('Could not create the Word file: ' + (e.message || e), 'err', 6000); }
  busy(false);
}

/* ---------- SETTINGS ---------- */
let _pendingLogo = null;
async function loadConfig() {
  try { CFG = await MobileAPI.getAppConfig(); } catch (e) { CFG = Object.assign({}, window.__DEFAULT_APP_CONFIG__, { logoDataUri: null }); }
}
async function openSettings() {
  T = { premeds: CFG.premeds.map(a => ({ drug: a[0] || '', dose: a[1] || '', route: a[2] || '' })),
        postmeds: CFG.postmeds.map(a => ({ drug: a[0] || '', dose: a[1] || '', route: a[2] || '', duration: a[3] || '' })),
        consultants: CFG.consultants.map(n => ({ name: n })) };
  _pendingLogo = null;
  const cc = await MobileAPI.getCloudConfig();
  $('#cfgSheetId').value = (cc && cc.spreadsheetId) || '';
  $('#cfgKeyName').textContent = cc && cc.keyFilePath ? 'Key loaded: ' + cc.keyFilePath : 'No key chosen';
  $('#logoPrev').src = CFG.logoDataUri || 'assets/letterhead.png';
  $('#cloudStatus').className = 'status';
  mountSettingsLists(); go('scrSettings');
}
let _setRenders = {};
function mountSettingsLists() {
  _setRenders.premeds = mountList($('#setPre'), () => T.premeds, [['drug', 'Drug', 'text'], ['dose', 'Dose', 'text', 'half'], ['route', 'Route', 'text', 'half']], { title: 'Pre-med' });
  _setRenders.postmeds = mountList($('#setPost'), () => T.postmeds, [['drug', 'Drug', 'text'], ['dose', 'Dose', 'text', 'half'], ['route', 'Frequency / route', 'text', 'half'], ['duration', 'Duration', 'text']], { title: 'Post-med' });
  _setRenders.consultants = mountList($('#setCons'), () => T.consultants, [['name', 'Name and qualification', 'text']], { title: 'Consultant' });
}
function setAdd(kind) { T[kind].push(kind === 'consultants' ? { name: '' } : kind === 'postmeds' ? { drug: '', dose: '', route: '', duration: '' } : { drug: '', dose: '', route: '' }); _setRenders[kind](); }
async function saveSettings() {
  const cfg = {
    premeds: T.premeds.filter(x => x.drug.trim()).map(x => [x.drug.trim(), x.dose.trim(), x.route.trim()]),
    postmeds: T.postmeds.filter(x => x.drug.trim()).map(x => [x.drug.trim(), x.dose.trim(), x.route.trim(), x.duration.trim()]),
    consultants: T.consultants.map(x => x.name.trim()).filter(Boolean),
    logoDataUri: _pendingLogo !== null ? (_pendingLogo || null) : CFG.logoDataUri,
  };
  const r = await MobileAPI.saveAppConfig(cfg);
  if (!r.ok) { toast('Could not save: ' + r.error, 'err'); return; }
  await loadConfig(); toast('Settings saved. New visits will use them.', 'ok');
}
async function resetSettings() {
  const c = await ask('Reset to defaults?', 'Logo, standard medicines and consultants go back to the original list.', [{ label: 'Reset', cls: 'danger', value: true }, { label: 'Cancel', cls: 'ghost', value: false }]);
  if (!c) return; await MobileAPI.saveAppConfig({}); await loadConfig(); _pendingLogo = null; openSettingsRefresh();
}
function openSettingsRefresh() { S.stack.pop(); openSettings(); toast('Reset to defaults.', 'ok'); }
async function chooseLogo() { const r = await MobileAPI.chooseLogoFile(); if (!r) return; _pendingLogo = r.dataUri; $('#logoPrev').src = r.dataUri; toast('Logo selected — tap “Save settings” to apply.', 'ok'); }
function resetLogo() { _pendingLogo = ''; $('#logoPrev').src = 'assets/letterhead.png'; toast('Default logo — tap “Save settings” to apply.', 'ok'); }
async function chooseKey() { const e = await MobileAPI.chooseKeyFile(); if (!e) { toast('That is not a valid Google key file.', 'warn'); return; } $('#cfgKeyName').textContent = 'Key chosen: ' + e; }
async function saveCloud() {
  const id = $('#cfgSheetId').value.trim(); const st = $('#cloudStatus');
  if (!id) { st.className = 'status show bad'; st.textContent = 'Enter the spreadsheet ID.'; return; }
  busy(true); const r = await MobileAPI.saveCloudConfig({ spreadsheetId: id }); busy(false);
  if (r.ok) { st.className = 'status show ok'; st.textContent = 'Connected to “' + (r.title || 'sheet') + '”. Auto-sync is on.'; setDot('ok'); }
  else { st.className = 'status show bad'; st.textContent = r.error; setDot('bad'); }
}
async function doBackup() { busy(true); const r = await MobileAPI.exportBackup(); busy(false); if (!r.ok) toast('Backup failed.', 'err'); }
async function doImport() { const r = await MobileAPI.importBackup(); if (r.ok) { toast(`Imported ${r.count} patient(s).`, 'ok'); await loadIndex(); } else if (r.error) toast('Import failed: ' + r.error, 'err'); }
async function doCsv() { busy(true); const r = await MobileAPI.exportCsv(); busy(false); if (!r.ok) toast('Export failed.', 'err'); }

/* ---------- cloud status dot ---------- */
function setDot(s) { const d = $('#cloudDot'); d.className = 'dot' + (s ? ' ' + s : ''); }
async function checkCloud(verbose) {
  try {
    const cc = await MobileAPI.getCloudConfig();
    if (!cc) { setDot(null); if (verbose) toast('Cloud sync is not set up. Open Settings to connect your Google Sheet.', 'warn', 5000); return; }
    const r = await MobileAPI.testCloudConnection();
    setDot(r.ok ? 'ok' : 'bad');
    if (verbose) toast(r.ok ? 'Cloud connected: ' + (r.title || 'sheet') : 'Cloud problem: ' + r.error, r.ok ? 'ok' : 'err', 5000);
  } catch (e) { setDot('bad'); }
}

/* ---------- boot ---------- */
async function boot() {
  bindEditor();
  await loadConfig();
  await renderHome();
  checkCloud(false); // auto-connect on open
  try {
    const A = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (A && A.addListener) A.addListener('backButton', () => {
      if ($('#overlayAsk').classList.contains('show')) return;
      if ($('#overlayOut').classList.contains('show')) { closeOutput(); return; }
      back();
    });
  } catch (e) {}
}
document.addEventListener('DOMContentLoaded', boot);
