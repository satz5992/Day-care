/* Data bridge: local storage (Capacitor Filesystem/Preferences) + Google Sheets sync. Same data format as the desktop app. */
const DEFAULT_STANDARD_PREMEDS = [
  ['Tab. Famotidine', '20 mg', 'PO stat'],
  ['Inj. Pantoprazole', '40 mg', 'IV'],
  ['Inj. Dexamethasone', '8 mg', 'IV'],
  ['Inj. Avil (Pheniramine)', '1 amp', 'IV'],
  ['Inj. Ondansetron', '8 mg', 'IV'],
  ['Cap. Aprepitant (Aprecap)', '125 mg', 'PO'],
  ['Tab. Dolo (Paracetamol)', '650 mg', 'PO'],
];
const DEFAULT_STANDARD_POSTMEDS = [
  ['Tab. Dexamethasone', '4 mg', 'OD (PO)', '3 days'],
  ['Tab. Pantoprazole', '40 mg', 'OD (PO)', '3 days'],
  ['Tab. Ondansetron', '8 mg', 'OD (PO)', '3 days'],
  ['Cap. Aprepitant (Aprecap)', '80 mg', 'OD (PO)', '2 days'],
];
const DEFAULT_CONSULTANTS = [
  'Dr. Hari Menon MD, DM',
  'Dr. Ganesha MD, DM',
  'Dr. Annie K Baa MD, DM',
  'Dr. Sanal Fernandes MD, DM',
];
window.__DEFAULT_APP_CONFIG__ = { premeds: DEFAULT_STANDARD_PREMEDS, postmeds: DEFAULT_STANDARD_POSTMEDS, consultants: DEFAULT_CONSULTANTS };
// ===== Mobile bridge: replaces Electron's window.api with Capacitor-based equivalents =====
let _sheetLock = Promise.resolve();
function withSheetLock(fn){ const run=_sheetLock.then(fn,fn); _sheetLock=run.catch(()=>{}); return run; }
const CAP = () => window.Capacitor && window.Capacitor.Plugins;

function safeFileNameMobile(uhid){ return uhid.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json'; }

// ---- Google service-account auth (client-side JWT signing via Web Crypto) ----
let _tokenCache = null;

async function pemToArrayBuffer(pem){
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64url(input){
  let str;
  if(typeof input === 'string'){ str = btoa(unescape(encodeURIComponent(input))); }
  else{ str = btoa(String.fromCharCode(...new Uint8Array(input))); }
  return str.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function getGoogleAccessToken(keyObj){
  const now = Math.floor(Date.now()/1000);
  const header = { alg:'RS256', typ:'JWT' };
  const claim = {
    iss: keyObj.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  };
  const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claim));
  const keyBuf = await pemToArrayBuffer(keyObj.private_key);
  const cryptoKey = await crypto.subtle.importKey('pkcs8', keyBuf, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + base64url(sigBuf);

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(jwt)
  });
  const data = await resp.json();
  if(!resp.ok) throw new Error(data.error_description || data.error || 'Google OAuth token request failed');
  return data.access_token;
}

async function getCachedAccessToken(keyObj){
  const now = Date.now();
  if(_tokenCache && _tokenCache.email === keyObj.client_email && _tokenCache.expiresAt > now + 30000) return _tokenCache.token;
  const token = await getGoogleAccessToken(keyObj);
  _tokenCache = { token, email: keyObj.client_email, expiresAt: now + 55*60*1000 };
  return token;
}

// ---- Sheets REST helpers ----
const SHEET_TAB = 'DayCareRecords';
const SHEET_HEADERS = [
  'UHID','Name','AgeSex','Dx','Consultant','Date','Regimen','Cycle','ECOG','HOPI',
  'BP','PR','SpO2','Temp','PremedsJSON','ChemoJSON','PostmedsJSON',
  'AE','AENotes','Advice','NextCycle','SavedAt','DischargeDate'
];

async function sheetsFetch(cfg, pathSuffix, options={}){
  const keyObj = JSON.parse(cfg.keyJson);
  const token = await getCachedAccessToken(keyObj);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheetId}${pathSuffix}`;
  const resp = await fetch(url, { ...options, headers:{ ...(options.headers||{}), 'Authorization':'Bearer '+token, 'Content-Type':'application/json' } });
  const data = await resp.json();
  if(!resp.ok) throw new Error((data.error && data.error.message) || 'Google Sheets API error');
  return data;
}
const sheetsGetMeta = (cfg) => sheetsFetch(cfg, '');
const sheetsGetValues = (cfg, range) => sheetsFetch(cfg, `/values/${encodeURIComponent(range)}`);
const sheetsUpdateValues = (cfg, range, values) => sheetsFetch(cfg, `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method:'PUT', body: JSON.stringify({values}) });
const sheetsAppendValues = (cfg, range, values) => sheetsFetch(cfg, `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method:'POST', body: JSON.stringify({values}) });

async function ensureSheetHeaderMobile(cfg){
  const res = await sheetsGetValues(cfg, `${SHEET_TAB}!A1:W1`);
  const row = (res.values && res.values[0]) || [];
  if(row.length === 0){ await sheetsUpdateValues(cfg, `${SHEET_TAB}!A1`, [SHEET_HEADERS]); }
}

function rowFromRecordMobile(uhid, r){
  return [
    uhid, r.name||'', r.ageSex||'', r.dx||'', r.consultant||'', r.date||'', r.regimen||'', r.cycle||'', r.ecog||'', r.hopi||'',
    r.bp||'', r.pr||'', r.spo2||'', r.temp||'',
    JSON.stringify(r.premeds||[]), JSON.stringify(r.chemo||[]), JSON.stringify(r.postmeds||[]),
    (r.ae||[]).join('; '), r.aeNotes||'', r.advice||'', r.nextCycle||'', r.savedAt||new Date().toISOString(), r.dischargeDate||''
  ];
}
function recordFromRowMobile(row){
  const g = (i) => row[i] || '';
  const parseJ = (s) => { try{ return JSON.parse(s || '[]'); }catch(e){ return []; } };
  return {
    name:g(1), ageSex:g(2), dx:g(3), consultant:g(4), date:g(5), regimen:g(6), cycle:g(7), ecog:g(8), hopi:g(9),
    bp:g(10), pr:g(11), spo2:g(12), temp:g(13),
    premeds:parseJ(g(14)), chemo:parseJ(g(15)), postmeds:parseJ(g(16)),
    ae: g(17) ? g(17).split(';').map(s=>s.trim()).filter(Boolean) : [],
    aeNotes:g(18), advice:g(19), nextCycle:g(20), savedAt:g(21), dischargeDate:g(22)
  };
}

async function upsertPatientToSheetMobile(cfg, uhid, patient){
  await ensureSheetHeaderMobile(cfg);
  const existing = await sheetsGetValues(cfg, `${SHEET_TAB}!A2:W`);
  const rows = existing.values || [];
  for(const r of (patient.records || [])){
    const key = `${uhid}|${r.date}|${r.cycle}`;
    const rowIdx = rows.findIndex(row => `${row[0]}|${row[5]}|${row[7]}` === key);
    const values = rowFromRecordMobile(uhid, r);
    if(rowIdx > -1){
      await sheetsUpdateValues(cfg, `${SHEET_TAB}!A${rowIdx+2}:W${rowIdx+2}`, [values]);
      rows[rowIdx] = values;
    }else{
      await sheetsAppendValues(cfg, `${SHEET_TAB}!A2:W`, [values]);
      rows.push(values);
    }
  }
}

async function fetchPatientFromSheetMobile(cfg, uhid){
  await ensureSheetHeaderMobile(cfg);
  const res = await sheetsGetValues(cfg, `${SHEET_TAB}!A2:W`);
  const rows = (res.values || []).filter(row => row[0] === uhid);
  const records = rows.map(recordFromRowMobile);
  const name = records.length ? records[records.length-1].name : '';
  return { name, records };
}

// ---- MobileAPI: same method names/shapes as desktop's window.api ----
const MobileAPI = {

  async getAppConfig(){
    const DEF = window.__DEFAULT_APP_CONFIG__;
    try{
      const { Preferences } = CAP();
      const res = await Preferences.get({ key:'app_config' });
      const saved = res.value ? JSON.parse(res.value) : {};
      const good = v => Array.isArray(v) && v.length > 0;
      return {
        premeds: good(saved.premeds) ? saved.premeds : DEF.premeds,
        postmeds: good(saved.postmeds) ? saved.postmeds : DEF.postmeds,
        consultants: good(saved.consultants) ? saved.consultants : DEF.consultants,
        logoDataUri: (typeof saved.logoDataUri==='string' && saved.logoDataUri) ? saved.logoDataUri : null
      };
    }catch(e){ return { ...DEF, logoDataUri:null }; }
  },
  async saveAppConfig(cfg){
    try{
      const { Preferences } = CAP();
      await Preferences.set({ key:'app_config', value: JSON.stringify(cfg||{}) });
      return { ok:true };
    }catch(err){ return { ok:false, error:String(err.message||err) }; }
  },
  async chooseLogoFile(){
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type='file'; input.accept='image/png,image/jpeg'; input.style.display='none';
      document.body.appendChild(input);
      input.onchange = () => {
        const file = input.files[0]; document.body.removeChild(input);
        if(!file){ resolve(null); return; }
        const r = new FileReader();
        r.onload = () => resolve({ dataUri: r.result });
        r.onerror = () => resolve(null);
        r.readAsDataURL(file);
      };
      input.click();
    });
  },
  async deleteCycle(uhid, date, cycle){
    let localDeleted = false;
    try{
      const { Filesystem, Preferences } = CAP();
      const res = await Filesystem.readFile({ path:`patients/${safeFileNameMobile(uhid)}`, directory:'DATA', encoding:'utf8' });
      const patient = JSON.parse(res.data);
      const before = (patient.records||[]).length;
      patient.records = (patient.records||[]).filter(r => !(r.date===date && r.cycle===cycle));
      localDeleted = patient.records.length < before;
      await Filesystem.writeFile({ path:`patients/${safeFileNameMobile(uhid)}`, data: JSON.stringify(patient,null,2), directory:'DATA', encoding:'utf8', recursive:true });
    }catch(e){}
    try{
      const cfg = await this._loadCloudCfg();
      if(cfg && cfg.spreadsheetId && cfg.keyJson){
        const out = await withSheetLock(async () => {
          await ensureSheetHeaderMobile(cfg);
          const meta = await sheetsGetMeta(cfg);
          const tab = (meta.sheets||[]).find(s => s.properties.title === SHEET_TAB);
          if(!tab) return false;
          const rows = (await sheetsGetValues(cfg, `${SHEET_TAB}!A2:W`)).values || [];
          const idx = rows.findIndex(row => row[0]===uhid && row[5]===date && row[7]===cycle);
          if(idx === -1) return false;
          await sheetsFetch(cfg, ':batchUpdate', { method:'POST', body: JSON.stringify({ requests:[{ deleteDimension:{ range:{ sheetId: tab.properties.sheetId, dimension:'ROWS', startIndex: idx+1, endIndex: idx+2 } } }] }) });
          return true;
        });
        return { ok:true, localDeleted, cloudDeleted: out };
      }
    }catch(err){
      return { ok:true, localDeleted, cloudDeleted:false, cloudError:String(err.message||err) };
    }
    return { ok:true, localDeleted, cloudDeleted:false };
  },
  async deletePatient(){ return { ok:false }; },
  async getAppVersion(){ return '1.0.0 (Android)'; },
  onUpdateStatus(){ },
  async checkForUpdates(){ return { ok:false, error:'On Android, install the newest APK to update.' }; },
  installUpdateNow(){ },
  async getDataDir(){ return 'This device (private app storage)'; },

  async getIndex(){
    try{
      const { Preferences } = CAP();
      const res = await Preferences.get({ key: 'patients_index' });
      return res.value ? JSON.parse(res.value) : [];
    }catch(e){ return []; }
  },

  async getPatient(uhid){
    try{
      const { Filesystem } = CAP();
      const res = await Filesystem.readFile({ path: `patients/${safeFileNameMobile(uhid)}`, directory: 'DATA', encoding: 'utf8' });
      return JSON.parse(res.data);
    }catch(e){ return null; }
  },

  async _loadCloudCfg(){
    const { Preferences } = CAP();
    const res = await Preferences.get({ key: 'cloud_config' });
    return res.value ? JSON.parse(res.value) : null;
  },

  async savePatient(uhid, patientObj){
    try{
      const { Filesystem, Preferences } = CAP();
      await Filesystem.writeFile({ path: `patients/${safeFileNameMobile(uhid)}`, data: JSON.stringify(patientObj, null, 2), directory: 'DATA', encoding: 'utf8', recursive: true });
      const idxRes = await Preferences.get({ key: 'patients_index' });
      let index = idxRes.value ? JSON.parse(idxRes.value) : [];
      index = index.filter(p => p.uhid !== uhid);
      index.push({ uhid, name: patientObj.name || '' });
      await Preferences.set({ key: 'patients_index', value: JSON.stringify(index) });
    }catch(err){
      return { ok:true, cloudSynced:false, cloudError: 'Local save failed: ' + (err.message||err) };
    }
    try{
      const cfg = await this._loadCloudCfg();
      if(cfg && cfg.spreadsheetId && cfg.keyJson){
        await withSheetLock(() => upsertPatientToSheetMobile(cfg, uhid, patientObj));
        return { ok:true, cloudSynced:true };
      }
      return { ok:true, cloudSynced:false };
    }catch(err){
      return { ok:true, cloudSynced:false, cloudError: String(err.message||err) };
    }
  },

  async getCloudConfig(){
    const cfg = await this._loadCloudCfg();
    if(!cfg) return null;
    let label = 'Key loaded';
    try{ label = JSON.parse(cfg.keyJson).client_email || label; }catch(e){}
    return { spreadsheetId: cfg.spreadsheetId, keyFilePath: label };
  },

  async chooseKeyFile(){
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'application/json,.json';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = () => {
        const file = input.files[0];
        document.body.removeChild(input);
        if(!file){ resolve(null); return; }
        const reader = new FileReader();
        reader.onload = () => {
          try{
            const keyObj = JSON.parse(reader.result);
            if(!keyObj.private_key || !keyObj.client_email){ resolve(null); return; }
            window._pendingKeyJsonText = reader.result;
            resolve(keyObj.client_email);
          }catch(e){ resolve(null); }
        };
        reader.readAsText(file);
      };
      input.click();
    });
  },

  async saveCloudConfig({ spreadsheetId }){
    try{
      let keyJson = window._pendingKeyJsonText;
      if(!keyJson){ const prev = await this._loadCloudCfg(); keyJson = prev && prev.keyJson; }
      if(!keyJson) return { ok:false, error:'Choose the Google key file first.' };
      const cfg = { spreadsheetId, keyJson };
      const meta = await sheetsGetMeta(cfg);
      await ensureSheetHeaderMobile(cfg);
      const { Preferences } = CAP();
      await Preferences.set({ key:'cloud_config', value: JSON.stringify(cfg) });
      return { ok:true, title: meta.properties && meta.properties.title };
    }catch(err){
      return { ok:false, error: String(err.message||err) };
    }
  },

  async testCloudConnection(){
    try{
      const cfg = await this._loadCloudCfg();
      if(!cfg) return { ok:false, error:'No cloud configuration saved yet.' };
      const meta = await sheetsGetMeta(cfg);
      return { ok:true, title: meta.properties && meta.properties.title };
    }catch(err){
      return { ok:false, error: String(err.message||err) };
    }
  },

  async pullFromCloud(uhid){
    try{
      const cfg = await this._loadCloudCfg();
      if(!cfg) return { ok:false, error:'Cloud sync not configured on this device.' };
      const cloudResult = await fetchPatientFromSheetMobile(cfg, uhid);
      if(!cloudResult.records.length) return { ok:true, count:0, name:'' };

      const { Filesystem, Preferences } = CAP();
      let patient = { uhid, name: cloudResult.name, records: [] };
      try{
        const res = await Filesystem.readFile({ path:`patients/${safeFileNameMobile(uhid)}`, directory:'DATA', encoding:'utf8' });
        patient = JSON.parse(res.data);
      }catch(e){}
      cloudResult.records.forEach(cr => {
        const idx = patient.records.findIndex(r => r.date===cr.date && r.cycle===cr.cycle);
        if(idx > -1) patient.records[idx] = cr; else patient.records.push(cr);
      });
      patient.name = cloudResult.name || patient.name;
      await Filesystem.writeFile({ path:`patients/${safeFileNameMobile(uhid)}`, data: JSON.stringify(patient, null, 2), directory:'DATA', encoding:'utf8', recursive:true });
      const idxRes = await Preferences.get({ key:'patients_index' });
      let index = idxRes.value ? JSON.parse(idxRes.value) : [];
      index = index.filter(p => p.uhid !== uhid);
      index.push({ uhid, name: patient.name || '' });
      await Preferences.set({ key:'patients_index', value: JSON.stringify(index) });

      return { ok:true, count: patient.records.length, name: patient.name };
    }catch(err){
      return { ok:false, error: String(err.message||err) };
    }
  },

  async exportBackup(){
    try{
      const index = await this.getIndex();
      const bundle = { exportedAt: new Date().toISOString(), patients:{} };
      const { Filesystem, Share } = CAP();
      for(const p of index){
        try{
          const res = await Filesystem.readFile({ path:`patients/${safeFileNameMobile(p.uhid)}`, directory:'DATA', encoding:'utf8' });
          bundle.patients[p.uhid] = JSON.parse(res.data);
        }catch(e){}
      }
      const fname = `DayCare_Records_Backup_${new Date().toISOString().slice(0,10)}.json`;
      await Filesystem.writeFile({ path:`exports/${fname}`, data: JSON.stringify(bundle, null, 2), directory:'CACHE', encoding:'utf8', recursive:true });
      const uriRes = await Filesystem.getUri({ path:`exports/${fname}`, directory:'CACHE' });
      await Share.share({ title:'Day care records backup', url: uriRes.uri });
      return { ok:true, count: index.length, filePath: fname };
    }catch(err){
      return { ok:false, count:0 };
    }
  },

  async importBackup(){
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'application/json,.json';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = () => {
        const file = input.files[0];
        document.body.removeChild(input);
        if(!file){ resolve({ ok:false, count:0 }); return; }
        const reader = new FileReader();
        reader.onload = async () => {
          try{
            const bundle = JSON.parse(reader.result);
            const patients = bundle.patients || {};
            const { Filesystem, Preferences } = CAP();
            const idxRes = await Preferences.get({ key:'patients_index' });
            let index = idxRes.value ? JSON.parse(idxRes.value) : [];
            for(const uhid of Object.keys(patients)){
              await Filesystem.writeFile({ path:`patients/${safeFileNameMobile(uhid)}`, data: JSON.stringify(patients[uhid], null, 2), directory:'DATA', encoding:'utf8', recursive:true });
              index = index.filter(p => p.uhid !== uhid);
              index.push({ uhid, name: patients[uhid].name || '' });
            }
            await Preferences.set({ key:'patients_index', value: JSON.stringify(index) });
            resolve({ ok:true, count: Object.keys(patients).length });
          }catch(e){
            resolve({ ok:false, count:0, error:String(e.message||e) });
          }
        };
        reader.readAsText(file);
      };
      input.click();
    });
  },

  async exportCsv(){
    try{
      const index = await this.getIndex();
      const { Filesystem, Share } = CAP();
      const headers = ['UHID','Patient Name','Age / Sex','Diagnosis','Consultant','Date','Regimen','Cycle / Day','ECOG PS','HOPI','Blood Pressure','Pulse Rate','SpO2','Temperature','Pre-medication','Chemotherapy Administered','Post-medication','Tolerance / Adverse Events','Tolerance Notes','Discharge Advice','Next Review Date','Saved At','Date of Discharge'];
      const esc = (v) => { const s = v===undefined||v===null ? '' : String(v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
      const medsToText = (list, fields) => (list||[]).map(m => fields.map(f=>m[f]).filter(Boolean).join(' ')).join(' | ');
      let rows = [headers.map(esc).join(',')];
      for(const p of index){
        try{
          const res = await Filesystem.readFile({ path:`patients/${safeFileNameMobile(p.uhid)}`, directory:'DATA', encoding:'utf8' });
          const patient = JSON.parse(res.data);
          (patient.records || []).forEach(r => {
            rows.push([p.uhid, r.name, r.ageSex, r.dx, r.consultant, r.date, r.regimen, r.cycle, r.ecog, r.hopi, r.bp, r.pr, r.spo2, r.temp,
              medsToText(r.premeds,['drug','dose','route']), medsToText(r.chemo,['drug','dose','route','diluent','duration']), medsToText(r.postmeds,['drug','dose','route','duration']),
              (r.ae||[]).join('; '), r.aeNotes, r.advice, r.nextCycle, r.savedAt, r.dischargeDate].map(esc).join(','));
          });
        }catch(e){}
      }
      const csvContent = '\ufeff' + rows.join('\r\n');
      const fname = `DayCare_Records_${new Date().toISOString().slice(0,10)}.csv`;
      await Filesystem.writeFile({ path:`exports/${fname}`, data: csvContent, directory:'CACHE', encoding:'utf8', recursive:true });
      const uriRes = await Filesystem.getUri({ path:`exports/${fname}`, directory:'CACHE' });
      await Share.share({ title:'Day care records spreadsheet', url: uriRes.uri });
      return { ok:true, count: rows.length-1, filePath: fname };
    }catch(err){
      return { ok:false, count:0 };
    }
  },

  async saveWordDoc(html, defaultName){
    try{
      const { Filesystem, Share } = CAP();
      await Filesystem.writeFile({ path:`exports/${defaultName}`, data: html, directory:'CACHE', encoding:'utf8', recursive:true });
      const uriRes = await Filesystem.getUri({ path:`exports/${defaultName}`, directory:'CACHE' });
      await Share.share({ title: defaultName, url: uriRes.uri });
      return { ok:true, filePath: defaultName };
    }catch(err){
      return { ok:false };
    }
  }
};
