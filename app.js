// ============================================================
//  Raj Bills – Invoice & Ledger System  |  app.js  v2.2
//  Features: PWA, Google Drive auto-backup, mobile-friendly,
//  import/export, selectable ledger output (standalone / continuous)
//  v2.1: Selectable row PDF — pick any entries, then print
//  v2.2: BUG FIX — selection mode double-fire & DOM sync issues
// ============================================================

// ============================
// GOOGLE DRIVE SYNC
// ============================
const DRIVE_FILE_NAME   = 'rajbills_data.json';
const DRIVE_FOLDER_NAME = 'RajBills';
const DRIVE_SCOPE       = 'https://www.googleapis.com/auth/drive.file';
const LS_DRIVE_TOKEN      = 'rajbills_drive_token';
const LS_DRIVE_TOKEN_EXP  = 'rajbills_drive_token_exp';
const LS_DRIVE_FILE_ID    = 'rajbills_drive_file_id';
const LS_DRIVE_FOLDER_ID  = 'rajbills_drive_folder_id';
const LS_DRIVE_CLIENT_ID  = 'rajbills_drive_client_id';

let DRIVE_CLIENT_ID   = localStorage.getItem(LS_DRIVE_CLIENT_ID) || '';
let _driveToken       = null;
let _driveTokenExp    = 0;
let _driveFolderId    = localStorage.getItem(LS_DRIVE_FOLDER_ID) || null;
let _driveFileId      = localStorage.getItem(LS_DRIVE_FILE_ID)   || null;
let _driveSaveTimer   = null;
let _driveRefreshTimer = null;
let _gapiReady        = false;
let _fileHandle       = null;

function onGapiLoad() {
  gapi.load('client', async () => {
    try {
      await gapi.client.init({});
      await gapi.client.load('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest');
      _gapiReady = true;
      tryAutoReconnectDrive();
    } catch(e) { console.warn('[Drive] gapi init failed:', e); }
  });
}

async function tryAutoReconnectDrive() {
  if (!DRIVE_CLIENT_ID || !window.google?.accounts) return;
  const storedToken = localStorage.getItem(LS_DRIVE_TOKEN);
  const storedExp   = parseInt(localStorage.getItem(LS_DRIVE_TOKEN_EXP) || '0', 10);
  const BUFFER_MS   = 5 * 60 * 1000;
  if (storedToken && storedExp && (storedExp - Date.now()) > BUFFER_MS) {
    _driveToken = storedToken; _driveTokenExp = storedExp;
    gapi.client.setToken({ access_token: _driveToken });
    updateDriveUI(true); updateDriveStatus('Auto-connected ✅');
    scheduleTokenRefresh(); return;
  }
  silentTokenRefresh().catch(() => {
    updateDriveUI(false); updateDriveStatus('Not connected. Tap ☁️ to connect.');
  });
}

function silentTokenRefresh() {
  return new Promise((resolve, reject) => {
    if (!DRIVE_CLIENT_ID) { reject(new Error('No client ID')); return; }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: DRIVE_CLIENT_ID, scope: DRIVE_SCOPE, prompt: 'none',
      callback: (resp) => {
        if (resp.error) { reject(new Error(resp.error)); return; }
        _onTokenReceived(resp, true); resolve();
      }
    });
    client.requestAccessToken();
  });
}

function driveSignIn() {
  if (!DRIVE_CLIENT_ID) {
    toast('Paste your Google Client ID in the Drive panel first.', 'error');
    openDrivePanel(); return;
  }
  if (!window.google?.accounts) {
    toast('Google script not loaded. Check internet.', 'error'); return;
  }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: DRIVE_CLIENT_ID, scope: DRIVE_SCOPE,
    callback: (resp) => {
      if (resp.error) { toast('Drive sign-in failed: ' + resp.error, 'error'); return; }
      _onTokenReceived(resp, false);
    }
  });
  client.requestAccessToken();
}

async function _onTokenReceived(resp, silent) {
  _driveToken = resp.access_token;
  const expiresIn = (resp.expires_in || 3600) * 1000;
  _driveTokenExp  = Date.now() + expiresIn;
  localStorage.setItem(LS_DRIVE_TOKEN,     _driveToken);
  localStorage.setItem(LS_DRIVE_TOKEN_EXP, String(_driveTokenExp));
  gapi.client.setToken({ access_token: _driveToken });
  updateDriveUI(true);
  if (!silent) toast('Connected to Google Drive!', 'success');
  scheduleTokenRefresh();
  if (!_driveFolderId) await driveFindOrCreateFolder();
  if (!_driveFileId)   await driveFindFile();
  updateDriveStatus(_driveFileId ? 'Connected ✅ — backup file found.' : 'Connected ✅ — will create backup on first save.');
  updateDriveLastSync();
}

function scheduleTokenRefresh() {
  clearTimeout(_driveRefreshTimer);
  const refreshIn = Math.max(_driveTokenExp - Date.now() - 5 * 60 * 1000, 0);
  _driveRefreshTimer = setTimeout(() => silentTokenRefresh().catch(() => {}), refreshIn);
}

function driveSignOut() {
  if (_driveToken && window.google) google.accounts.oauth2.revoke(_driveToken, () => {});
  _driveToken = null; _driveTokenExp = 0; _driveFolderId = null; _driveFileId = null;
  clearTimeout(_driveSaveTimer); clearTimeout(_driveRefreshTimer);
  [LS_DRIVE_TOKEN, LS_DRIVE_TOKEN_EXP, LS_DRIVE_FILE_ID, LS_DRIVE_FOLDER_ID].forEach(k => localStorage.removeItem(k));
  updateDriveUI(false); toast('Disconnected from Google Drive.');
}

function saveDriveClientId() {
  const val = (document.getElementById('driveClientIdInput').value || '').trim();
  if (!val) { toast('Paste a Client ID first.', 'error'); return; }
  DRIVE_CLIENT_ID = val;
  localStorage.setItem(LS_DRIVE_CLIENT_ID, val);
  toast('Client ID saved!', 'success');
}

function updateDriveUI(connected) {
  const topBtn = document.getElementById('driveTopBtn');
  if (topBtn) {
    topBtn.textContent = connected ? '☁️✅' : '☁️';
    topBtn.style.background  = connected ? 'rgba(30,132,73,0.3)' : 'rgba(255,255,255,0.15)';
    topBtn.style.borderColor = connected ? 'rgba(30,132,73,0.7)' : 'rgba(255,255,255,0.3)';
  }
  ['driveUploadBtn','driveDownloadBtn'].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = !connected;
  });
  const si = document.getElementById('driveSignInBtn');
  const so = document.getElementById('driveSignOutBtn');
  if (si) si.style.display = connected ? 'none' : 'inline-flex';
  if (so) so.style.display = connected ? 'inline-flex' : 'none';
  const inp = document.getElementById('driveClientIdInput');
  if (inp && DRIVE_CLIENT_ID && !inp.value) inp.value = DRIVE_CLIENT_ID;
}

function updateDriveStatus(msg) {
  const el = document.getElementById('driveStatusText'); if (el) el.textContent = msg;
}

function updateDriveLastSync() {
  const el = document.getElementById('driveLastSync');
  if (el) el.textContent = 'Last synced: ' + new Date().toLocaleTimeString('en-IN');
}

async function ensureValidToken() {
  if (!_driveToken) return false;
  if (Date.now() < _driveTokenExp - 60000) return true;
  try { await silentTokenRefresh(); return true; }
  catch(e) { updateDriveUI(false); return false; }
}

async function driveFindOrCreateFolder() {
  if (!_driveToken) return;
  try {
    const res = await gapi.client.drive.files.list({
      q: `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)', spaces: 'drive'
    });
    if (res.result.files.length > 0) {
      _driveFolderId = res.result.files[0].id;
    } else {
      const folder = await gapi.client.drive.files.create({
        resource: { name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }, fields: 'id'
      });
      _driveFolderId = folder.result.id;
    }
    localStorage.setItem(LS_DRIVE_FOLDER_ID, _driveFolderId);
  } catch(e) { console.error('[Drive] Folder error:', e); }
}

async function driveFindFile() {
  if (!_driveToken || !_driveFolderId) return;
  try {
    const res = await gapi.client.drive.files.list({
      q: `name='${DRIVE_FILE_NAME}' and '${_driveFolderId}' in parents and trashed=false`,
      fields: 'files(id)', spaces: 'drive'
    });
    if (res.result.files.length > 0) {
      _driveFileId = res.result.files[0].id;
      localStorage.setItem(LS_DRIVE_FILE_ID, _driveFileId);
    }
  } catch(e) { console.error('[Drive] File search error:', e); }
}

async function driveUpload(silent = false) {
  if (!_driveToken) { if (!silent) toast('Connect to Google Drive first.', 'error'); return; }
  const valid = await ensureValidToken();
  if (!valid) { if (!silent) toast('Drive session expired. Tap ☁️ to reconnect.', 'error'); return; }
  if (!_driveFolderId) await driveFindOrCreateFolder();
  const content  = JSON.stringify(state, null, 2);
  const metadata = { name: DRIVE_FILE_NAME, mimeType: 'application/json' };
  if (!_driveFileId) metadata.parents = [_driveFolderId];
  const boundary = 'rajbills_multipart';
  const body = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata), `--${boundary}`, 'Content-Type: application/json', '', content, `--${boundary}--`].join('\r\n');
  const method = _driveFileId ? 'PATCH' : 'POST';
  const url = _driveFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${_driveFileId}?uploadType=multipart`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  try {
    if (!silent) updateDriveStatus('Uploading…');
    const res = await fetch(url, {
      method, body,
      headers: { 'Authorization': 'Bearer ' + _driveToken, 'Content-Type': `multipart/related; boundary=${boundary}` }
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || 'Upload failed'); }
    const data = await res.json();
    _driveFileId = data.id;
    localStorage.setItem(LS_DRIVE_FILE_ID, _driveFileId);
    if (!silent) toast('Saved to Google Drive!', 'success');
    updateDriveLastSync(); updateDriveStatus('Synced ✅');
  } catch(e) {
    if (!silent) toast('Drive upload failed: ' + e.message, 'error');
    updateDriveStatus('Upload failed: ' + e.message);
  }
}

async function driveDownload() {
  if (!_driveToken) { toast('Connect to Google Drive first.', 'error'); return; }
  const valid = await ensureValidToken();
  if (!valid) { toast('Drive session expired. Tap ☁️ to reconnect.', 'error'); return; }
  if (!_driveFolderId) await driveFindOrCreateFolder();
  if (!_driveFileId)   await driveFindFile();
  if (!_driveFileId)   { toast('No backup found in Drive yet.', 'error'); return; }
  try {
    updateDriveStatus('Downloading…');
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${_driveFileId}?alt=media`,
      { headers: { 'Authorization': 'Bearer ' + _driveToken } });
    if (!res.ok) throw new Error('Download failed');
    const loaded = await res.json();
    if (loaded && Array.isArray(loaded.customers) && Array.isArray(loaded.products)) {
      state = loaded;
      save();
      toast('Data restored from Google Drive!', 'success');
      updateDriveStatus('Restored ✅');
      setTimeout(() => location.reload(), 800);
    } else { toast('Invalid backup file', 'error'); }
  } catch(e) { toast('Drive download failed: ' + e.message, 'error'); }
}

function scheduleDriveUpload() {
  if (!_driveToken) return;
  clearTimeout(_driveSaveTimer);
  _driveSaveTimer = setTimeout(() => driveUpload(true), 8000);
}

function openDrivePanel() {
  const inp = document.getElementById('driveClientIdInput');
  if (inp && DRIVE_CLIENT_ID) inp.value = DRIVE_CLIENT_ID;
  updateDriveUI(!!_driveToken);
  openModal('drivePanelModal');
}

// ============================
// PWA INSTALL
// ============================
function pwaInstall() {
  const prompt = window._deferredInstallPrompt;
  if (!prompt) {
    toast('Open in Chrome/Edge/Safari and use browser menu → Add to Home Screen', '');
    return;
  }
  prompt.prompt();
  prompt.userChoice.then(function(choice) {
    if (choice.outcome === 'accepted') {
      ['pwaInstallBtn','pwaInstallMenuBtn'].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
      });
    }
    window._deferredInstallPrompt = null;
  });
}


function getCustomerPrefix(cId) {
  const c = state.customers.find(x => x.id === cId);
  if (!c) return 'X';
  const initial = c.name.charAt(0).toUpperCase();
  const sameInitialCusts = state.customers.filter(x => x.name.charAt(0).toUpperCase() === initial).sort((a,b) => a.id - b.id);
  const idx = sameInitialCusts.findIndex(x => x.id === cId);
  return idx === 0 ? initial : initial + String(idx);
}

function generateInvNo(cId) {
  if (!cId) return '';
  const prefix = getCustomerPrefix(cId);
  const count = state.ledger.filter(e => e.customerId === cId).length + 1;
  return `RB-${prefix}-${String(count).padStart(3, '0')}`;
}

// ============================
// DATA FILE SAVE / LOAD
// ============================
async function saveToFile() {
  const data = JSON.stringify(state, null, 2);
  if (window.showSaveFilePicker && !_fileHandle) {
    try {
      _fileHandle = await window.showSaveFilePicker({
        suggestedName: 'rajbills_data.json',
        types: [{ description: 'JSON Data File', accept: { 'application/json': ['.json'] } }]
      });
    } catch(e) { if (e.name === 'AbortError') return; }
  }
  if (_fileHandle) {
    try {
      const w = await _fileHandle.createWritable();
      await w.write(data); await w.close();
      toast('Saved to rajbills_data.json', 'success'); return;
    } catch(e) { _fileHandle = null; }
  }
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'rajbills_data.json';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  toast('rajbills_data.json downloaded', 'success');
}

function loadFromFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const imported = JSON.parse(e.target.result);
      if (imported && Array.isArray(imported.customers) && Array.isArray(imported.products)) {
        state = imported;
        save(); toast('Data imported!', 'success');
        setTimeout(() => location.reload(), 800);
      } else { toast('Invalid data file format', 'error'); }
    } catch(err) { toast('Could not read file', 'error'); }
    event.target.value = '';
  };
  reader.readAsText(file);
}

// ============================
// DATA STORE
// ============================
let state = {
  products: [{ id: 1, name: 'Amul Butter 500gm', rate: 268, unit: 'pcs' }],
  customers: [{ id: 1, name: 'F.M.B.', address: 'Haluriya chowk, Bhavnagar', phone: '', overwrites: {} }],
  ledger: [], payments: [],
  selectedCustomer: null, invoiceRows: [],
  editMode: { type: null, id: null },
  pendingDelete: { type: null, id: null },
  tempOverwrites: {}
};

function save() {
  const data = JSON.stringify(state, null, 2);
  try {
    localStorage.setItem('rajbills', data);
    const el = document.getElementById('saveIndicator');
    if (el) { el.textContent = '✅ Saved'; el.style.opacity = '1'; setTimeout(() => { el.style.opacity = '0'; }, 2000); }
  } catch(e) { console.warn('localStorage save failed', e); }
  scheduleDriveUpload();
  if (_fileHandle) {
    _fileHandle.createWritable().then(w => w.write(data).then(() => w.close())).catch(() => {});
  }
}

function load() {
  const d = localStorage.getItem('rajbills') || localStorage.getItem('rajmart');
  if (d) { try { state = JSON.parse(d); } catch(e) {} }
}
load();

// ============================
// UTILITY
// ============================
function fmt(n) { return '₹' + parseFloat(n || 0).toFixed(2); }
function today() { const d = new Date(); return d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
function todayFull() { const d = new Date(); return d.toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }); }
function uid() { return Date.now() + Math.floor(Math.random()*1000); }

function toast(msg, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show ' + type;
  setTimeout(() => t.className = 'toast', 2800);
}
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function parseDateIN(str) {
  if (!str) return new Date(0);
  const p = str.split('/');
  if (p.length === 3) return new Date(`${p[2]}-${p[1]}-${p[0]}`);
  return new Date(str);
}
function fmtK(n) {
  if (n >= 100000) return '₹' + (n/100000).toFixed(1) + 'L';
  if (n >= 1000) return '₹' + (n/1000).toFixed(1) + 'K';
  return '₹' + parseFloat(n || 0).toFixed(0);
}

// ============================
// PAGE NAVIGATION
// ============================
function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.querySelectorAll('.desktop-nav button[id^="nav-"]').forEach(b => b.classList.remove('active'));
  const navBtn = document.getElementById('nav-' + page);
  if (navBtn) navBtn.classList.add('active');
  document.querySelectorAll('.mobile-nav-btn[id^="mnav-"]').forEach(b => b.classList.remove('active'));
  const mnavBtn = document.getElementById('mnav-' + page);
  if (mnavBtn) mnavBtn.classList.add('active');
  const tabMap = { dashboard:'tab-dashboard', invoice:'tab-invoice', ledger:'tab-ledger', customers:'tab-customers', products:'tab-more' };
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const tabId = tabMap[page];
  if (tabId) { const el = document.getElementById(tabId); if (el) el.classList.add('active'); }
  const menu = document.getElementById('mobileMenu');
  if (menu && menu.classList.contains('open')) {
    menu.classList.remove('open');
    document.getElementById('mobileMenuOverlay')?.classList.remove('open');
    document.getElementById('hamburgerBtn')?.classList.remove('open');
  }
  if (page === 'dashboard') renderDashboard();
  if (page === 'ledger') renderLedger();
  if (page === 'products') renderProductsPage();
  if (page === 'customers') renderCustomersPage();
}

// ============================
// DASHBOARD
// ============================
function getFilteredLedger() {
  const custId = document.getElementById('dashCustomer').value;
  const period = document.getElementById('dashPeriod').value;
  let entries = [...state.ledger];
  if (custId) entries = entries.filter(e => String(e.customerId) === custId);
  const now = new Date();
  if (period === 'today') {
    const t = now.toLocaleDateString('en-IN', { day:'2-digit', month:'2-digit', year:'numeric' });
    entries = entries.filter(e => e.date === t);
  } else if (period === 'week') {
    const weekAgo = new Date(now - 7 * 86400000);
    entries = entries.filter(e => parseDateIN(e.date) >= weekAgo);
  } else if (period === 'month') {
    entries = entries.filter(e => { const d = parseDateIN(e.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
  } else if (period === 'custom') {
    const from = document.getElementById('dateFrom').value;
    const to = document.getElementById('dateTo').value;
    if (from) entries = entries.filter(e => parseDateIN(e.date) >= new Date(from));
    if (to) entries = entries.filter(e => parseDateIN(e.date) <= new Date(to + 'T23:59:59'));
  }
  return entries;
}

function getTotalPaidForFilter(custId) {
  return (state.payments||[]).filter(p => !custId || String(p.customerId) === String(custId)).reduce((s,p) => s+p.amount, 0);
}

function renderDashboard() {
  const period = document.getElementById('dashPeriod').value;
  const crp = document.getElementById('customRangePicker');
  if (crp) crp.style.display = period === 'custom' ? 'flex' : 'none';
  document.getElementById('dashDate').textContent = new Date().toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

  const cSelect = document.getElementById('dashCustomer');
  const curVal = cSelect.value;
  cSelect.innerHTML = '<option value="">All Customers</option>' +
    state.customers.map(c => `<option value="${c.id}" ${String(c.id) === curVal ? 'selected' : ''}>${c.name}</option>`).join('');

  const entries = getFilteredLedger();
  const custId = document.getElementById('dashCustomer').value;
  const totalSales = entries.reduce((s,e) => s+e.total, 0);
  const totalInvoices = entries.length;
  const totalPaid = getTotalPaidForFilter(custId);
  const remaining = Math.max(0, totalSales - totalPaid);
  const avgOrder = totalInvoices ? totalSales/totalInvoices : 0;
  const uniqueCustomers = new Set(entries.map(e => e.customerId)).size;
  const largest = entries.reduce((m,e) => e.total > m ? e.total : m, 0);

  document.getElementById('kpiGrid').innerHTML = `
    <div class="kpi-card kpi-red"><div class="kpi-label">Total Sales</div><div class="kpi-value">${fmtK(totalSales)}</div><div class="kpi-sub">${totalInvoices} invoice${totalInvoices!==1?'s':''}</div></div>
    <div class="kpi-card kpi-green"><div class="kpi-label">Amount Paid</div><div class="kpi-value">${fmtK(totalPaid)}</div><div class="kpi-sub">${totalSales>0?Math.round((Math.min(totalPaid,totalSales)/totalSales)*100):0}% collected</div></div>
    <div class="kpi-card kpi-orange"><div class="kpi-label">Remaining</div><div class="kpi-value">${fmtK(remaining)}</div><div class="kpi-sub">Outstanding</div></div>
    <div class="kpi-card kpi-blue"><div class="kpi-label">Avg Order</div><div class="kpi-value">${fmtK(avgOrder)}</div><div class="kpi-sub">Per invoice</div></div>
    <div class="kpi-card kpi-purple"><div class="kpi-label">Customers</div><div class="kpi-value">${custId?'1':uniqueCustomers}</div><div class="kpi-sub">Active this period</div></div>
    <div class="kpi-card kpi-teal"><div class="kpi-label">Largest</div><div class="kpi-value">${fmtK(largest)}</div><div class="kpi-sub">Single invoice</div></div>`;

  const paidPct = totalSales > 0 ? Math.min(100,(totalPaid/totalSales)*100) : 0;
  const remPct  = 100 - paidPct;
  let custPayRows = '';
  const custMap = {};
  entries.forEach(e => { if(!custMap[e.customerId]) custMap[e.customerId]={name:e.customerName,billed:0}; custMap[e.customerId].billed += e.total; });
  const payments = state.payments||[];
  custPayRows = Object.entries(custMap).map(([cid,d]) => {
    const paid = payments.filter(p=>String(p.customerId)===String(cid)).reduce((s,p)=>s+p.amount,0);
    const rem  = Math.max(0,d.billed-paid);
    const pct  = d.billed>0 ? Math.min(100,(paid/d.billed)*100) : 0;
    return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:9px;font-size:12px;flex-wrap:wrap;">
      <div style="width:140px;font-weight:600;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${d.name}</div>
      <div style="flex:1;min-width:70px;"><div class="payment-bar-track"><div class="payment-bar-fill" style="width:${pct}%;background:linear-gradient(90deg,#27ae60,#1e8449);"></div></div></div>
      <div style="font-size:11px;color:#27ae60;font-family:'IBM Plex Mono',monospace;width:75px;text-align:right;">₹${paid.toFixed(0)} pd</div>
      <div style="font-size:11px;color:var(--red);font-family:'IBM Plex Mono',monospace;width:75px;text-align:right;">₹${rem.toFixed(0)} due</div>
    </div>`;
  }).join('');

  document.getElementById('paymentProgress').innerHTML = `
    <div class="payment-bar-wrap" style="margin-bottom:14px;">
      <div class="payment-bar-labels">
        <span style="font-weight:600;">Paid <span style="color:#27ae60;font-family:'IBM Plex Mono',monospace;">₹${totalPaid.toFixed(2)}</span></span>
        <span style="font-weight:600;">Remaining <span style="color:var(--red);font-family:'IBM Plex Mono',monospace;">₹${remaining.toFixed(2)}</span></span>
      </div>
      <div class="payment-bar-track" style="height:16px;margin:6px 0;">
        <div class="payment-bar-fill" style="width:${paidPct}%;background:linear-gradient(90deg,#27ae60,#1e8449);"></div>
        <div class="payment-bar-fill" style="width:${remPct}%;background:linear-gradient(90deg,#f5b7b1,var(--red));"></div>
      </div>
    </div>
    ${custPayRows?`<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px;">${custPayRows}</div>`:''}`;

  renderBarChart(entries); renderTopCustomers(entries); renderProductChart(entries); renderRecentInvoices(entries);
}

function renderBarChart(entries) {
  const months = [];
  const now = new Date();
  for (let i=5;i>=0;i--) {
    const d = new Date(now.getFullYear(),now.getMonth()-i,1);
    months.push({label:d.toLocaleString('default',{month:'short'}),year:d.getFullYear(),month:d.getMonth(),total:0});
  }
  entries.forEach(e => { const d=parseDateIN(e.date); const m=months.find(x=>x.month===d.getMonth()&&x.year===d.getFullYear()); if(m) m.total+=e.total; });
  const maxVal = Math.max(...months.map(m=>m.total),1);
  document.getElementById('barChart').innerHTML = months.map(m => `
    <div class="bar-wrap">
      <div class="bar" style="height:${Math.max(4,(m.total/maxVal)*110)}px;"><div class="bar-tooltip">${fmtK(m.total)}</div></div>
      <div class="bar-label">${m.label}</div>
    </div>`).join('');
}

function renderTopCustomers(entries) {
  const custMap = {};
  entries.forEach(e => { if(!custMap[e.customerId]) custMap[e.customerId]={name:e.customerName,total:0,count:0}; custMap[e.customerId].total+=e.total; custMap[e.customerId].count++; });
  const sorted = Object.values(custMap).sort((a,b)=>b.total-a.total).slice(0,5);
  const maxTotal = sorted.length ? sorted[0].total : 1;
  if(!sorted.length){document.getElementById('topCustomers').innerHTML='<div class="empty-state"><div class="empty-state-icon">📊</div><div class="empty-state-text">No data yet</div></div>';return;}
  document.getElementById('topCustomers').innerHTML = sorted.map((c,i) => `
    <div class="cust-rank-row">
      <div class="cust-rank-num" style="color:${i===0?'var(--red)':i===1?'#e67e22':i===2?'#2980b9':'var(--text-muted)'};">${i+1}</div>
      <div style="flex:1;">
        <div class="cust-rank-name">${c.name}</div>
        <div class="cust-rank-invoices">${c.count} invoice${c.count!==1?'s':''}</div>
        <div class="cust-rank-bar"><div class="cust-rank-bar-fill" style="width:${Math.max(4,(c.total/maxTotal)*100)}%;"></div></div>
      </div>
      <div class="cust-rank-amount">${fmtK(c.total)}</div>
    </div>`).join('');
}

function renderProductChart(entries) {
  const prodMap = {};
  entries.forEach(e => { (e.items||[]).forEach(item => { if(!prodMap[item.name]) prodMap[item.name]={qty:0,revenue:0}; prodMap[item.name].qty+=parseFloat(item.qty)||0; prodMap[item.name].revenue+=parseFloat(item.amount)||0; }); });
  const sorted = Object.entries(prodMap).sort((a,b)=>b[1].revenue-a[1].revenue).slice(0,6);
  const maxRev = sorted.length ? sorted[0][1].revenue : 1;
  if(!sorted.length){document.getElementById('productChart').innerHTML='<div class="empty-state"><div class="empty-state-icon">📦</div><div class="empty-state-text">No data yet</div></div>';return;}
  document.getElementById('productChart').innerHTML = sorted.map(([name,d]) => `
    <div class="product-bar-row">
      <div class="product-bar-header"><span class="product-bar-name">${name}</span><span class="product-bar-val">${d.qty} qty · ${fmtK(d.revenue)}</span></div>
      <div class="product-bar-track"><div class="product-bar-fill" style="width:${Math.max(4,(d.revenue/maxRev)*100)}%;"></div></div>
    </div>`).join('');
}

function renderRecentInvoices(entries) {
  const recent = [...entries].slice(0,8);
  if(!recent.length){document.getElementById('recentInvoices').innerHTML='<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">No invoices yet</div></div>';return;}
  document.getElementById('recentInvoices').innerHTML = recent.map(e => `
    <div class="recent-invoice-row">
      <div class="ri-no">${e.invoiceNo}</div>
      <div class="ri-cust">${e.customerName}</div>
      <div class="ri-date">${e.date}</div>
      <div class="ri-amt">${fmtK(e.total)}</div>
    </div>`).join('');
}

// ============================
// PAYMENTS
// ============================
function openPaymentModal() {
  if (!state.payments) state.payments = [];
  const sel = document.getElementById('payCustomer');
  const custId = document.getElementById('dashCustomer').value;
  sel.innerHTML = '<option value="">— Select Customer —</option>' +
    state.customers.map(c => `<option value="${c.id}" ${String(c.id)===custId?'selected':''}>${c.name}</option>`).join('');
  document.getElementById('payAmount').value = '';
  document.getElementById('payNote').value = '';
  document.getElementById('payDate').value = new Date().toISOString().split('T')[0];
  updatePaymentInfo();
  openModal('paymentModal');
}

function updatePaymentInfo() {
  if (!state.payments) state.payments = [];
  const cid = document.getElementById('payCustomer').value;
  const info = document.getElementById('payOutstandingInfo');
  const histList = document.getElementById('payHistoryList');
  if (!cid) { info.style.display='none'; histList.innerHTML=''; return; }
  const billed = state.ledger.filter(e=>String(e.customerId)===cid).reduce((s,e)=>s+e.total,0);
  const paid   = state.payments.filter(p=>String(p.customerId)===cid).reduce((s,p)=>s+p.amount,0);
  info.style.display='block';
  document.getElementById('payTotalBilled').textContent='₹'+billed.toFixed(2);
  document.getElementById('payAlreadyPaid').textContent='₹'+paid.toFixed(2);
  document.getElementById('payOutstanding').textContent='₹'+Math.max(0,billed-paid).toFixed(2);
  const hist = state.payments.filter(p=>String(p.customerId)===cid).sort((a,b)=>new Date(b.date)-new Date(a.date));
  histList.innerHTML = hist.length ? hist.map(p => `
    <div class="pay-hist-item">
      <div><div style="font-weight:600;">${p.date}</div><div style="font-size:11px;color:var(--text-muted);">${p.method||'Offline'} · ${p.note||'Payment'}</div></div>
      <div style="display:flex;align-items:center;gap:8px;"><span class="ph-amount">+₹${p.amount.toFixed(2)}</span><button class="btn btn-danger btn-sm" onclick="deletePayment(${p.id})">✕</button></div>
    </div>`).join('')
    : '<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">No payments yet</div>';
}

function savePayment() {
  if (!state.payments) state.payments = [];
  const cid    = document.getElementById('payCustomer').value;
  const amount = parseFloat(document.getElementById('payAmount').value);
  const method = document.getElementById('payMethod').value;
  const date   = document.getElementById('payDate').value;
  const note   = document.getElementById('payNote').value.trim();
  if (!cid)              { toast('Select a customer', 'error'); return; }
  if (!amount||amount<=0){ toast('Enter a valid amount', 'error'); return; }
  state.payments.push({ id: uid(), customerId: parseInt(cid), amount, date, note, method });
  save(); toast('Payment recorded!', 'success');
  updatePaymentInfo(); renderDashboard(); renderCustomerList();
}

function deletePayment(id) {
  state.payments = (state.payments||[]).filter(p => p.id !== id);
  save(); updatePaymentInfo(); renderDashboard(); renderCustomerList(); toast('Payment removed');
}

// ============================
// CUSTOMER LIST (SIDEBAR + MOBILE)
// ============================
function renderCustomerList() {
  const q = (document.getElementById('customerSearch')?.value || '').toLowerCase();
  const list = document.getElementById('customerList');
  const filtered = state.customers.filter(c => c.name.toLowerCase().includes(q));

  const mSel = document.getElementById('mobileCustomerSelect');
  if (mSel) {
    mSel.innerHTML = '<option value="">— Select Customer —</option>' +
      state.customers.map(c => `<option value="${c.id}" ${state.selectedCustomer===c.id?'selected':''}>${c.name}</option>`).join('');
  }

  if (!list) return;
  if (!filtered.length) { list.innerHTML = '<div style="text-align:center;padding:16px;font-size:12px;color:var(--text-muted);">No customers found</div>'; return; }
  list.innerHTML = filtered.map(c => {
    const billed = state.ledger.filter(e=>String(e.customerId)===String(c.id)).reduce((s,e)=>s+e.total,0);
    const paid   = (state.payments||[]).filter(p=>String(p.customerId)===String(c.id)).reduce((s,p)=>s+p.amount,0);
    const due    = billed - paid;
    const dueLabel = due > 0.005
      ? `<span style="font-size:10px;font-family:'IBM Plex Mono',monospace;color:var(--red);font-weight:700;margin-top:2px;display:block;">₹${due.toFixed(0)} due</span>`
      : due < -0.005
        ? `<span style="font-size:10px;font-family:'IBM Plex Mono',monospace;color:#27ae60;font-weight:700;margin-top:2px;display:block;">₹${Math.abs(due).toFixed(0)} CR</span>`
        : billed > 0 ? `<span style="font-size:10px;color:#27ae60;font-weight:600;margin-top:2px;display:block;">✓ Settled</span>` : '';
    return `<div class="customer-item ${state.selectedCustomer===c.id?'selected':''}" onclick="selectCustomer(${c.id})">
      <div class="customer-name">${c.name}</div>
      <div class="customer-address">${c.address||'—'}</div>
      ${dueLabel}
    </div>`;
  }).join('');
}

function selectCustomerById(id) {
  if (!id) return;
  selectCustomer(parseInt(id));
}

function selectCustomer(id) {
  state.selectedCustomer = id;

  if (document.getElementById('page-ledger').classList.contains('active')) {
    document.getElementById('ledgerCustomerFilter').value = id;
    renderLedger(); renderCustomerList(); return;
  }

  const c = state.customers.find(x => x.id === id);
  if (!document.getElementById('page-invoice').classList.contains('active')) showPage('invoice');

  document.getElementById('noCustomerMsg').style.display = 'none';
  const banner = document.getElementById('selectedCustomerBanner');
  banner.style.display = 'flex';
  document.getElementById('selCustName').textContent = c.name;
  document.getElementById('selCustAddr').textContent = c.address || '';
  document.getElementById('invNoInput').value = generateInvNo(id);
  document.getElementById('invDateDisplay').textContent = todayFull();
  document.getElementById('invoiceBuilderCard').style.display = 'block';
  if (document.getElementById('invoiceInitialPayment')) document.getElementById('invoiceInitialPayment').value = '';
  document.getElementById('invoiceDatePicker').value = new Date().toISOString().split('T')[0];
  document.getElementById('invoiceDescription').value = '';

  const mSel = document.getElementById('mobileCustomerSelect');
  if (mSel) mSel.value = id;

  renderCustomerList();
  if (!state.invoiceRows.length) addInvoiceRow();
  renderInvoiceRows();
}

// ============================
// INVOICE BUILDER
// ============================
function addInvoiceRow() {
  state.invoiceRows.push({ rowId: uid(), productId: null, qty: 1, overwriteRate: null });
  renderInvoiceRows();
}

function removeInvoiceRow(rowId) {
  state.invoiceRows = state.invoiceRows.filter(r => r.rowId !== rowId);
  renderInvoiceRows();
}

function renderInvoiceRows() {
  const c = state.customers.find(x => x.id === state.selectedCustomer);
  const container = document.getElementById('invoiceRows');
  container.innerHTML = state.invoiceRows.map(row => {
    const product = state.products.find(p => p.id === row.productId);
    let rate = product ? parseFloat(product.rate) : 0;
    let isOverwritten = false;
    if (product && c && c.overwrites && c.overwrites[product.id] !== undefined) { rate = parseFloat(c.overwrites[product.id]); isOverwritten = true; }
    if (row.overwriteRate !== null && row.overwriteRate !== undefined && row.overwriteRate !== '') { rate = parseFloat(row.overwriteRate); isOverwritten = true; }
    const qty = parseFloat(row.qty) || 0;
    const amount = rate * qty;
    const productOptions = state.products.map(p => `<option value="${p.id}" ${row.productId===p.id?'selected':''}>${p.name}</option>`).join('');
    return `<div class="invoice-product-row" id="row-${row.rowId}">
      <div>
        <select onchange="updateRow(${row.rowId},'productId',this.value)" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;font-family:'IBM Plex Sans',sans-serif;outline:none;" onfocus="this.style.borderColor='var(--red)'" onblur="this.style.borderColor='var(--border)'">
          <option value="">— Select —</option>${productOptions}
        </select>
        ${isOverwritten?'<span class="overwrite-badge" style="margin-left:4px;">Special Rate</span>':''}
      </div>
      <input type="number" min="1" value="${row.qty}" placeholder="Qty" style="text-align:center;" onchange="updateRow(${row.rowId},'qty',this.value)" onfocus="this.style.borderColor='var(--red)'" onblur="this.style.borderColor='var(--border)'">
      <input type="number" value="${rate||''}" placeholder="Rate" style="text-align:center;" onchange="updateRow(${row.rowId},'overwriteRate',this.value)" onfocus="this.style.borderColor='var(--red)'" onblur="this.style.borderColor='var(--border)'">
      <input type="text" value="${product?fmt(amount):''}" readonly style="text-align:right;font-family:'IBM Plex Mono',monospace;font-weight:600;background:var(--light-gray);color:var(--text-muted);">
      <button class="btn btn-danger btn-sm" onclick="removeInvoiceRow(${row.rowId})">✕</button>
    </div>`;
  }).join('');
  recalcInvoice();
}

function updateRow(rowId, field, value) {
  const row = state.invoiceRows.find(r => r.rowId === rowId);
  if (!row) return;
  if (field === 'productId') row.productId = parseInt(value) || null;
  else if (field === 'qty') row.qty = parseFloat(value) || 1;
  else if (field === 'overwriteRate') row.overwriteRate = value === '' ? null : parseFloat(value);
  renderInvoiceRows();
}

function recalcInvoice() {
  const c = state.customers.find(x => x.id === state.selectedCustomer);
  let total = 0;
  state.invoiceRows.forEach(row => {
    const product = state.products.find(p => p.id === row.productId);
    if (!product) return;
    let rate = parseFloat(product.rate);
    if (c && c.overwrites && c.overwrites[product.id] !== undefined) rate = parseFloat(c.overwrites[product.id]);
    if (row.overwriteRate !== null && row.overwriteRate !== undefined && row.overwriteRate !== '') rate = parseFloat(row.overwriteRate);
    total += rate * (parseFloat(row.qty) || 0);
  });
  document.getElementById('subtotalDisplay').textContent = fmt(total);
  document.getElementById('grandTotalDisplay').textContent = fmt(total);
}

function clearInvoice() {
  state.invoiceRows = [];
  renderInvoiceRows();
  if (document.getElementById('invoiceInitialPayment')) document.getElementById('invoiceInitialPayment').value = '';
  toast('Invoice cleared');
}

function updateInvoiceDateDisplay() {
  const val = document.getElementById('invoiceDatePicker').value;
  if (val) {
    const d = new Date(val + 'T00:00:00');
    document.getElementById('invDateDisplay').textContent = d.toLocaleDateString('en-IN', {weekday:'long',day:'2-digit',month:'2-digit',year:'numeric'});
  }
}

function getChosenDateISO() { return document.getElementById('invoiceDatePicker').value || new Date().toISOString().split('T')[0]; }
function chosenDateFormatted() { const iso = getChosenDateISO(); const d = new Date(iso+'T00:00:00'); return d.toLocaleDateString('en-IN',{weekday:'long',day:'2-digit',month:'2-digit',year:'numeric'}); }
function chosenDateShort() { const iso = getChosenDateISO(); const d = new Date(iso+'T00:00:00'); return d.toLocaleDateString('en-IN',{day:'2-digit',month:'2-digit',year:'numeric'}); }

function getInvoiceData() {
  const c = state.customers.find(x => x.id === state.selectedCustomer);
  if (!c) { toast('Please select a customer', 'error'); return null; }
  const items = []; let total = 0;
  state.invoiceRows.forEach(row => {
    const product = state.products.find(p => p.id === row.productId);
    if (!product) return;
    let rate = parseFloat(product.rate);
    if (c.overwrites && c.overwrites[product.id] !== undefined) rate = parseFloat(c.overwrites[product.id]);
    if (row.overwriteRate !== null && row.overwriteRate !== undefined && row.overwriteRate !== '') rate = parseFloat(row.overwriteRate);
    const qty = parseFloat(row.qty) || 0;
    const amount = rate * qty;
    total += amount;
    items.push({ name: product.name, qty, rate, amount });
  });
  if (!items.length) { toast('Add at least one product', 'error'); return null; }
  const desc = document.getElementById('invoiceDescription')?.value.trim() || '';
  const finalInvNo = document.getElementById('invNoInput').value.trim() || generateInvNo(c.id);
  return { customer: c, items, total, invoiceNo: finalInvNo, date: chosenDateFormatted(), dateShort: chosenDateShort(), description: desc };
}

function saveInvoiceToLedger() {
  const inv = getInvoiceData();
  if (!inv) return;
  const paymentAmt    = parseFloat(document.getElementById('invoiceInitialPayment').value) || 0;
  const paymentMethod = document.getElementById('invoicePaymentMethod').value;
  state.ledger.unshift({ id: uid(), invoiceNo: inv.invoiceNo, customerId: state.selectedCustomer, customerName: inv.customer.name, date: chosenDateShort(), description: inv.description, items: inv.items, total: inv.total });
  if (paymentAmt > 0) {
    if (!state.payments) state.payments = [];
    state.payments.push({ id: uid(), customerId: state.selectedCustomer, amount: paymentAmt, date: getChosenDateISO(), note: `Initial Payment for ${inv.invoiceNo}`, method: paymentMethod });
  }
  save(); toast('Invoice saved to ledger!', 'success');
  clearInvoice();
  document.getElementById('invNoInput').value = generateInvNo(state.selectedCustomer);
  renderCustomerList();
}

// ============================
// PRINTING
// ============================
function generateInvoicePrintHTML(inv, paymentAmt, paymentMethod) {
  const balance = inv.total - paymentAmt;
  const rowsHTML = inv.items.map((item,i) => `
    <tr>
      <td>${i+1}</td><td>${item.name}</td>
      <td style="text-align:center;">${item.qty}</td>
      <td style="text-align:right;font-family:'IBM Plex Mono',monospace;">${parseFloat(item.rate).toFixed(2)}</td>
      <td style="text-align:right;font-family:'IBM Plex Mono',monospace;">${parseFloat(item.amount).toFixed(2)}</td>
    </tr>`).join('');
  return `
    <div class="print-invoice">
      <div class="print-header">
        <div>
          <div class="print-brand">RAJ BILLS</div>
          <div class="print-shop-contact">Mobile: +91-9428205640</div>
        </div>
        <div class="print-invoice-meta">
          <div class="print-invoice-title">INVOICE</div>
          <div class="print-invoice-meta-line"><strong>Invoice No:</strong> ${inv.invoiceNo}</div>
          <div class="print-invoice-meta-line"><strong>Date:</strong> ${inv.date}</div>
        </div>
      </div>
      <div class="print-bill-to">
        <div class="print-bill-to-label">BILL TO</div>
        <div class="print-bill-to-name">${inv.customer.name}</div>
        <div class="print-bill-to-addr">${inv.customer.address||''}</div>
        ${inv.customer.phone?`<div class="print-bill-to-addr">${inv.customer.phone}</div>`:''}
      </div>
      ${inv.description?`<p style="font-size:13px;color:#555;margin-bottom:12px;">Note: ${inv.description}</p>`:''}
      <table class="print-table">
        <thead><tr><th>#</th><th>Product</th><th style="text-align:center;">Qty</th><th style="text-align:right;">Rate (₹)</th><th style="text-align:right;">Amount (₹)</th></tr></thead>
        <tbody>${rowsHTML}</tbody>
      </table>
      <div class="print-totals">
        <table class="print-totals-table">
          <tr><td>Subtotal</td><td style="text-align:right;font-family:'IBM Plex Mono',monospace;">${parseFloat(inv.total).toFixed(2)}</td></tr>
          <tr><td>Tax / GST</td><td style="text-align:right;font-family:'IBM Plex Mono',monospace;">0.00</td></tr>
          <tr class="grand-total-row"><td><strong>TOTAL</strong></td><td style="text-align:right;font-family:'IBM Plex Mono',monospace;"><strong>₹${parseFloat(inv.total).toFixed(2)}</strong></td></tr>
          ${paymentAmt>0?`
          <tr><td style="padding-top:10px;font-size:12px;color:#555;">Paid (${paymentMethod})</td><td style="padding-top:10px;text-align:right;font-family:'IBM Plex Mono',monospace;color:#27ae60;">-${paymentAmt.toFixed(2)}</td></tr>
          <tr><td style="font-weight:600;">Balance Due</td><td style="text-align:right;font-family:'IBM Plex Mono',monospace;font-weight:600;color:var(--red);">₹${balance.toFixed(2)}</td></tr>`:''}
        </table>
      </div>
      <div class="print-footer">Thank you for your business!<br>Raj Bills · +91-9428205640</div>
    </div>`;
}

function printInvoice() {
  const inv = getInvoiceData();
  if (!inv) return;
  const paymentAmt    = parseFloat(document.getElementById('invoiceInitialPayment').value) || 0;
  const paymentMethod = document.getElementById('invoicePaymentMethod').value;
  _openPreview(generateInvoicePrintHTML(inv, paymentAmt, paymentMethod));
}

function openInvoicePreview(id) {
  const e = state.ledger.find(x => x.id === id);
  if (!e) return;
  const cust = state.customers.find(c => c.id === e.customerId) || { name:e.customerName, address:'', phone:'' };
  let payAmt=0, payMethod='';
  const initPay = (state.payments||[]).find(p => p.note && p.note.includes(e.invoiceNo));
  if (initPay) { payAmt = initPay.amount; payMethod = initPay.method||'Offline'; }
  _openPreview(generateInvoicePrintHTML({ customer:cust, items:e.items, total:e.total, invoiceNo:e.invoiceNo, date:e.date, description:e.description }, payAmt, payMethod));
}

function _openPreview(html) {
  document.getElementById('invoicePreviewBody').innerHTML = html;
  window._previewHTML = html; openModal('invoicePreviewModal');
}

function doPrint() {
  document.getElementById('printArea').innerHTML = window._previewHTML || '';
  setTimeout(() => window.print(), 120);
}

function printInvoiceFromLedger(id) { openInvoicePreview(id); }

// ============================
// LEDGER PRINT — SELECTABLE MODE
// ============================
function openPrintLedgerModal() { openModal('printLedgerModal'); }

function printLedger(mode) {
  closeModal('printLedgerModal');
  const filter = document.getElementById('ledgerCustomerFilter').value;
  const invoices = filter ? state.ledger.filter(e => String(e.customerId)===String(filter)) : state.ledger;
  const payments = filter ? (state.payments||[]).filter(p => String(p.customerId)===String(filter)) : (state.payments||[]);
  const custName  = filter ? (state.customers.find(c => String(c.id)===filter)?.name||'Filtered') : 'All Customers';
  _doPrintLedger(mode, invoices, payments, custName, filter);
}

function printSelectedLedger(mode) {
  closeModal('printSelectedLedgerModal');
  const selectedIds = _getSelectedRowIds();
  if (!selectedIds.length) { toast('No entries selected', 'error'); return; }

  const filter = document.getElementById('ledgerCustomerFilter').value;
  const custName = filter ? (state.customers.find(c => String(c.id)===filter)?.name||'Filtered') : 'Multiple Customers';

  const invoices = [];
  const payments = [];
  selectedIds.forEach(sid => {
    const inv = state.ledger.find(e => String(e.id) === String(sid));
    if (inv) { invoices.push(inv); return; }
    const pay = (state.payments||[]).find(p => String(p.id) === String(sid));
    if (pay) payments.push(pay);
  });

  _doPrintLedger(mode, invoices, payments, custName, filter);
}

function _doPrintLedger(mode, invoices, payments, custName, filter) {
  const allRows = [];
  invoices.forEach(e => allRows.push({ type:'invoice', sortDate:parseDateIN(e.date), date:e.date, invoiceNo:e.invoiceNo, desc:[e.description,(e.items||[]).map(i=>i.name+'×'+i.qty).join(', ')].filter(Boolean).join(' — '), amount:e.total }));
  payments.forEach(p => {
    const ds = p.date ? new Date(p.date+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'2-digit',year:'numeric'}) : '-';
    allRows.push({ type:'payment', sortDate:p.date?new Date(p.date+'T00:00:00'):new Date(0), date:ds, invoiceNo:'—', desc:(p.note||'Payment')+(p.method==='Online'?' (Online)':''), amount:p.amount });
  });
  allRows.sort((a,b) => a.sortDate-b.sortDate || (a.type==='invoice'?-1:1));

  let openingBalance = 0;
  if (mode === 'continuous' && filter) {
    const allCustInvoices = state.ledger.filter(e => String(e.customerId)===String(filter));
    const allCustPayments = (state.payments||[]).filter(p => String(p.customerId)===String(filter));
    openingBalance = allCustInvoices.reduce((s,e)=>s+e.total,0) - allCustPayments.reduce((s,p)=>s+p.amount,0) - invoices.reduce((s,e)=>s+e.total,0) + payments.reduce((s,p)=>s+p.amount,0);
  }

  let bal = mode === 'continuous' ? openingBalance : 0;
  let totalDebit=0, totalCredit=0;

  const rowsHTML = allRows.map(r => {
    if (r.type==='invoice') {
      bal += r.amount; totalDebit += r.amount;
      return `<tr><td>${r.date}</td><td style="font-family:'IBM Plex Mono',monospace;">${r.invoiceNo}</td><td style="font-size:11px;">${r.desc}</td><td style="text-align:right;font-family:'IBM Plex Mono',monospace;">${r.amount.toFixed(2)}</td><td></td><td style="text-align:right;font-family:'IBM Plex Mono',monospace;">${bal.toFixed(2)}</td></tr>`;
    } else {
      bal -= r.amount; totalCredit += r.amount;
      return `<tr style="background:#f0fff4;"><td>${r.date}</td><td style="color:#aaa;">—</td><td style="font-size:11px;color:#27ae60;">${r.desc}</td><td></td><td style="text-align:right;font-family:'IBM Plex Mono',monospace;color:#27ae60;">${r.amount.toFixed(2)}</td><td style="text-align:right;font-family:'IBM Plex Mono',monospace;color:${bal<0?'#27ae60':'#c0392b'};">${Math.abs(bal).toFixed(2)}${bal<0?' CR':''}</td></tr>`;
    }
  }).join('');

  const modeLabel = mode === 'continuous' ? 'Continuous Ledger' : 'Standalone';
  const openingNote = mode === 'continuous' && openingBalance !== 0
    ? `<p style="font-size:11px;color:#b7950b;font-weight:700;">Opening balance: ₹${openingBalance.toFixed(2)}</p>` : '';
  const selectionNote = invoices.length < state.ledger.filter(e => filter ? String(e.customerId)===String(filter) : true).length
    ? `<p style="font-size:11px;color:#2980b9;font-weight:700;margin-bottom:4px;">Selected entries: ${invoices.length} invoice(s) + ${payments.length} payment(s)</p>` : '';

  document.getElementById('printArea').innerHTML = `
    <div class="print-ledger">
      <div class="print-header">
        <div><div class="print-brand">RAJ BILLS</div><div class="print-shop-contact">Customer Ledger — ${modeLabel}</div></div>
        <div class="print-invoice-meta">
          <div class="print-invoice-title">LEDGER</div>
          <div class="print-invoice-meta-line"><strong>Customer:</strong> ${custName}</div>
          <div class="print-invoice-meta-line"><strong>Generated:</strong> ${new Date().toLocaleDateString('en-IN')}</div>
        </div>
      </div>
      ${selectionNote}
      ${openingNote}
      <table class="print-table" style="width:100%;font-size:12px;margin-top:10px;">
        <thead><tr><th>Date</th><th>Invoice No</th><th>Description</th><th style="text-align:right;">Debit (₹)</th><th style="text-align:right;">Credit (₹)</th><th style="text-align:right;">Balance (₹)</th></tr></thead>
        <tbody>${rowsHTML}</tbody>
        <tfoot><tr>
          <td colspan="3" style="text-align:right;font-weight:700;padding-top:10px;">TOTAL</td>
          <td style="text-align:right;font-weight:700;font-family:'IBM Plex Mono',monospace;padding-top:10px;border-top:2px solid #c0392b;color:#c0392b;">${totalDebit.toFixed(2)}</td>
          <td style="text-align:right;font-weight:700;font-family:'IBM Plex Mono',monospace;padding-top:10px;border-top:2px solid #27ae60;color:#27ae60;">${totalCredit.toFixed(2)}</td>
          <td style="text-align:right;font-weight:700;font-family:'IBM Plex Mono',monospace;padding-top:10px;border-top:2px solid #2980b9;color:${(totalDebit-totalCredit)>0?'#c0392b':'#27ae60'};">${Math.abs(totalDebit-totalCredit).toFixed(2)}${(totalDebit-totalCredit)<0?' CR':''}</td>
        </tr></tfoot>
      </table>
      <div class="print-summary-section">
        <div class="print-summary-box"><div class="lbl">Total Billed</div><div class="val">₹${totalDebit.toFixed(2)}</div></div>
        <div class="print-summary-box"><div class="lbl">Total Paid</div><div class="val" style="color:#1e8449;">₹${totalCredit.toFixed(2)}</div></div>
        <div class="print-summary-box"><div class="lbl">Balance Due</div><div class="val" style="color:${(totalDebit-totalCredit)>0?'#c0392b':'#27ae60'};">₹${Math.abs(totalDebit-totalCredit).toFixed(2)}</div></div>
        ${mode==='continuous'&&openingBalance?`<div class="print-summary-box"><div class="lbl">Opening Bal</div><div class="val" style="color:#b7950b;">₹${openingBalance.toFixed(2)}</div></div>`:''}
      </div>
      <div class="print-footer">Mode: ${modeLabel} · Raj Bills · Generated ${new Date().toLocaleString('en-IN')}</div>
    </div>`;
  // Small delay so browser paints the DOM before opening print dialog
  setTimeout(() => window.print(), 120);
}

// ============================
// LEDGER PAGE — SELECTION MODE
// ============================
// FIX v2.2: _selectedRows is the single source of truth.
// toggleRowSelection() ONLY mutates _selectedRows + calls renderLedger().
// Mobile card onclick is REMOVED — only checkbox onchange fires.
// selectAllVisible() reads allRows from data, not DOM.

let _selectionMode = false;
let _selectedRows  = new Set(); // stores row IDs as strings

function toggleSelectionMode() {
  _selectionMode = !_selectionMode;
  _selectedRows.clear();
  renderLedger();
  const btn = document.getElementById('selModeBtn');
  if (btn) {
    btn.textContent = _selectionMode ? '✕ Cancel Select' : '☑ Select Entries';
    btn.classList.toggle('btn-primary', _selectionMode);
    btn.classList.toggle('btn-secondary', !_selectionMode);
  }
  const bar = document.getElementById('selectionActionBar');
  if (bar) bar.style.display = _selectionMode ? 'flex' : 'none';
  updateSelectionCount();
}

// FIX: removed manual DOM patching — just toggle the set and re-render
function toggleRowSelection(id) {
  const sid = String(id);
  if (_selectedRows.has(sid)) {
    _selectedRows.delete(sid);
  } else {
    _selectedRows.add(sid);
  }
  // Re-render to keep all views in sync (both mobile cards and desktop table)
  renderLedger();
  updateSelectionCount();
}

// FIX: selectAllVisible now derives allIds from state data, not DOM queries
function selectAllVisible() {
  const filter = document.getElementById('ledgerCustomerFilter').value;
  const invoices = filter ? state.ledger.filter(e => String(e.customerId)===String(filter)) : state.ledger;
  const payments = filter ? (state.payments||[]).filter(p => String(p.customerId)===String(filter)) : (state.payments||[]);
  const allIds = [
    ...invoices.map(e => String(e.id)),
    ...payments.map(p => String(p.id))
  ];

  const allSelected = allIds.length > 0 && allIds.every(id => _selectedRows.has(id));
  if (allSelected) {
    allIds.forEach(id => _selectedRows.delete(id));
  } else {
    allIds.forEach(id => _selectedRows.add(id));
  }
  renderLedger();
  updateSelectionCount();
}

function _getSelectedRowIds() { return [..._selectedRows]; }

function updateSelectionCount() {
  const count = _selectedRows.size;
  const countEl = document.getElementById('selectionCount');
  if (countEl) countEl.textContent = count > 0 ? `${count} entr${count===1?'y':'ies'} selected` : 'No entries selected';
  const printBtn = document.getElementById('selPrintBtn');
  if (printBtn) printBtn.disabled = count === 0;
}

function openPrintSelectedModal() {
  if (_selectedRows.size === 0) { toast('Select at least one entry first', 'error'); return; }
  const invCount = [..._selectedRows].filter(id => state.ledger.find(e => String(e.id) === id)).length;
  const payCount = _selectedRows.size - invCount;
  const summEl = document.getElementById('selPrintSummary');
  if (summEl) summEl.textContent = `${invCount} invoice(s) + ${payCount} payment(s) selected`;
  openModal('printSelectedLedgerModal');
}

// ============================
// LEDGER PAGE
// ============================
function clearLedgerFilter() {
  document.getElementById('ledgerCustomerFilter').value = '';
  state.selectedCustomer = null;
  renderLedger(); renderCustomerList();
}

function renderLedger() {
  const cFilter = document.getElementById('ledgerCustomerFilter');
  const currentVal = cFilter.value;
  cFilter.innerHTML = '<option value="">All Customers</option>' +
    state.customers.map(c => `<option value="${c.id}" ${currentVal==c.id?'selected':''}>${c.name}</option>`).join('');
  const filter = cFilter.value;

  const labelEl = document.getElementById('ledgerCustomerLabel');
  const clearBtn = document.getElementById('ledgerClearFilter');
  if (filter) {
    const cName = (state.customers.find(c=>String(c.id)===String(filter))||{}).name||'';
    labelEl.textContent = cName; labelEl.style.display='inline-block'; clearBtn.style.display='inline-block';
  } else {
    labelEl.style.display='none'; clearBtn.style.display='none';
  }

  const invoices = filter ? state.ledger.filter(e=>String(e.customerId)===String(filter)) : state.ledger;
  const payments = filter ? (state.payments||[]).filter(p=>String(p.customerId)===String(filter)) : (state.payments||[]);
  const totalDebit  = invoices.reduce((s,e)=>s+e.total,0);
  const totalCredit = payments.reduce((s,p)=>s+p.amount,0);
  const netBalance  = totalDebit - totalCredit;

  document.getElementById('ledgerStats').innerHTML = `
    <div class="ledger-stat debit"><div class="ledger-stat-label">Total Orders (Debit)</div><div class="ledger-stat-value">${fmt(totalDebit)}</div></div>
    <div class="ledger-stat credit"><div class="ledger-stat-label">Total Payments (Credit)</div><div class="ledger-stat-value" style="color:var(--success);">${fmt(totalCredit)}</div></div>
    <div class="ledger-stat balance"><div class="ledger-stat-label">Net Balance Due</div><div class="ledger-stat-value" style="color:${netBalance>0.005?'var(--red)':'#27ae60'};">${fmt(Math.abs(netBalance))}${netBalance<-0.005?' CR':''}</div></div>`;

  const tbody = document.getElementById('ledgerBody');
  const allRows = [];
  invoices.forEach(e => allRows.push({ type:'invoice', sortDate:parseDateIN(e.date), date:e.date, invoiceNo:e.invoiceNo, customerName:e.customerName, desc:e.description||'', items:e.items||[], amount:e.total, id:e.id }));
  payments.forEach(p => {
    const cn = (state.customers.find(c=>String(c.id)===String(p.customerId))||{}).name||'-';
    const ds = p.date ? new Date(p.date+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'2-digit',year:'numeric'}) : '-';
    const label = (p.note||'Payment')+(p.method==='Online'?' (Online)':'');
    allRows.push({ type:'payment', sortDate:p.date?new Date(p.date+'T00:00:00'):new Date(0), date:ds, invoiceNo:'—', customerName:cn, desc:label, items:[], amount:p.amount, id:p.id });
  });

  if (!allRows.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">No entries yet. Create an invoice to get started.</div></div></td></tr>';
    document.getElementById('ledgerCards').innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">No entries yet.</div></div>';
    return;
  }

  allRows.sort((a,b) => a.sortDate-b.sortDate || (a.type==='invoice'?-1:1));
  let runBal = 0;
  allRows.forEach(row => { if(row.type==='invoice') runBal+=row.amount; else runBal-=row.amount; row.balance=runBal; });

  const balColor = b => Math.abs(b)<0.005?'#888':b<0?'#27ae60':'var(--red)';
  const balLabel = b => fmt(Math.abs(b))+(b<-0.005?' CR':'');

  // Checkbox cell: uses onchange only — no onclick on the row
  // FIX: stopPropagation on the label prevents bubbling when clicking checkbox label itself
  const selChkTd = (rowId) => _selectionMode
    ? `<td style="width:36px;text-align:center;" onclick="event.stopPropagation()"><label class="sel-checkbox"><input type="checkbox" ${_selectedRows.has(String(rowId))?'checked':''} onchange="toggleRowSelection(${rowId})"><span class="sel-checkmark"></span></label></td>`
    : '';

  // ── Desktop table rows ──
  tbody.innerHTML = allRows.map(row => {
    const isSel = _selectedRows.has(String(row.id));
    if (row.type==='payment') {
      return `<tr style="background:#f0fff4;" data-id="${row.id}" class="${isSel?'selected-row':''}">
        ${selChkTd(row.id)}
        <td><span class="mono" style="font-size:12px;">${row.date}</span></td>
        <td><span style="color:var(--text-muted);">—</span></td>
        <td style="font-size:12px;color:var(--text-muted);">${row.customerName}</td>
        <td style="font-size:12px;color:var(--success);font-weight:600;">${row.desc}</td>
        <td class="text-right" style="color:var(--text-muted);">—</td>
        <td class="text-right"><strong class="mono" style="color:var(--success);">${fmt(row.amount)}</strong></td>
        <td class="text-right"><strong class="mono" style="color:${balColor(row.balance)};">${balLabel(row.balance)}</strong></td>
        <td><button class="btn btn-danger btn-sm" onclick="deletePaymentRow(${row.id})">✕</button></td>
      </tr>`;
    } else {
      const itemsStr = row.items.map(i=>i.name+'×'+i.qty).join(', ');
      const fullDesc = [row.desc, itemsStr].filter(Boolean).join(' — ');
      return `<tr data-id="${row.id}" class="${isSel?'selected-row':''}">
        ${selChkTd(row.id)}
        <td><span class="mono" style="font-size:12px;">${row.date}</span></td>
        <td><span class="mono" style="font-weight:600;">${row.invoiceNo}</span></td>
        <td style="font-size:12px;">${row.customerName}</td>
        <td style="font-size:12px;color:var(--text-muted);">${fullDesc||'—'}</td>
        <td class="text-right"><strong class="mono text-red">${fmt(row.amount)}</strong></td>
        <td class="text-right" style="color:var(--text-muted);">—</td>
        <td class="text-right"><strong class="mono" style="color:${balColor(row.balance)};">${balLabel(row.balance)}</strong></td>
        <td>
          <div style="display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap;">
            <button class="btn btn-info btn-sm" onclick="openInvoicePreview(${row.id})" title="Preview">👁</button>
            <button class="btn btn-secondary btn-sm" onclick="openEditEntryModal(${row.id})">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteEntry(${row.id})">Del</button>
          </div>
        </td>
      </tr>`;
    }
  }).join('');

  // Update select-all header checkboxes
  const selAllTh = document.getElementById('selAllTh');
  if (selAllTh) selAllTh.style.display = _selectionMode ? 'table-cell' : 'none';

  const allIds = allRows.map(r => String(r.id));
  const allSelected = allIds.length > 0 && allIds.every(id => _selectedRows.has(id));
  const someSelected = allIds.some(id => _selectedRows.has(id));

  // Sync both select-all checkboxes (mobile action bar + desktop header)
  ['selAllCheckbox', 'selAllCheckboxDesktop'].forEach(cbId => {
    const cb = document.getElementById(cbId);
    if (cb && _selectionMode) {
      cb.checked = allSelected;
      cb.indeterminate = !allSelected && someSelected;
    }
  });

  // ── Mobile card rows ──
  // FIX: card onclick is REMOVED. Only the checkbox onchange drives selection.
  //      A separate tap-zone covers the whole card but uses stopPropagation on
  //      the checkbox wrapper to prevent double-fire.
  const cards = document.getElementById('ledgerCards');
  cards.innerHTML = allRows.map(row => {
    const isPay = row.type === 'payment';
    const amtClass = isPay ? 'credit' : 'debit';
    const itemsStr = (row.items||[]).map(i=>i.name+'×'+i.qty).join(', ');
    const fullDesc = isPay ? row.desc : [row.desc, itemsStr].filter(Boolean).join(' — ');
    const isSel = _selectedRows.has(String(row.id));

    // FIX: In selection mode, the whole card is a tap target → toggleRowSelection.
    //      The checkbox wrapper stops propagation so the onchange doesn't double-fire.
    const cardOnclick = _selectionMode ? `onclick="toggleRowSelection(${row.id})"` : '';

    const selCheckHTML = _selectionMode
      ? `<span class="sel-checkbox-wrap" onclick="event.stopPropagation()" style="margin-right:8px;margin-top:2px;flex-shrink:0;display:inline-flex;">
           <label class="sel-checkbox">
             <input type="checkbox" ${isSel?'checked':''} onchange="toggleRowSelection(${row.id})">
             <span class="sel-checkmark"></span>
           </label>
         </span>`
      : '';

    const actionsHTML = isPay
      ? `<button class="btn btn-danger btn-sm" onclick="deletePaymentRow(${row.id})">✕ Delete</button>`
      : `<button class="btn btn-info btn-sm" onclick="openInvoicePreview(${row.id})">👁 View</button>
         <button class="btn btn-secondary btn-sm" onclick="openEditEntryModal(${row.id})">✏️ Edit</button>
         <button class="btn btn-danger btn-sm" onclick="deleteEntry(${row.id})">🗑 Del</button>`;

    return `<div class="ledger-card ${isPay?'pay-card':''} ${isSel?'selected-row':''}" data-id="${row.id}" ${cardOnclick}>
      <div class="lc-top">
        ${selCheckHTML}
        <div class="lc-left">
          <div class="lc-date">${row.date}${isPay?' · Payment':''}</div>
          <div class="lc-invno">${isPay?'—':row.invoiceNo}</div>
          <div class="lc-customer">${row.customerName}</div>
          ${fullDesc?`<div class="lc-desc">${fullDesc}</div>`:''}
        </div>
        <div class="lc-right">
          <div class="lc-amount ${amtClass}">${isPay?'+':''}${fmt(row.amount)}</div>
          <div class="lc-balance" style="color:${balColor(row.balance)};">Bal: ${balLabel(row.balance)}</div>
        </div>
      </div>
      ${!_selectionMode ? `<div class="lc-actions">${actionsHTML}</div>` : ''}
    </div>`;
  }).join('');

  // Keep the action bar visible if we're in selection mode (renderLedger doesn't touch its display)
  const bar = document.getElementById('selectionActionBar');
  if (bar) bar.style.display = _selectionMode ? 'flex' : 'none';
}

function deletePaymentRow(id) {
  state.payments = (state.payments||[]).filter(p=>String(p.id)!==String(id));
  save(); renderLedger(); renderDashboard(); toast('Payment deleted');
}

// ============================
// EDIT ENTRY MODAL
// ============================
let _editItems = [];

function openEditEntryModal(id) {
  const e = state.ledger.find(x => x.id === id);
  if (!e) return;
  state.editMode = { type:'ledgerEntry', id };
  _editItems = (e.items||[]).map(item => ({ ...item }));
  document.getElementById('editEntryDate').value = parseDateIN(e.date).toISOString().split('T')[0];
  document.getElementById('editEntryDesc').value = e.description || '';
  renderEditItems(); openModal('editEntryModal');
}

function renderEditItems() {
  const container = document.getElementById('editItemsContainer');
  if (!_editItems.length) { container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:6px 0;">No items</div>'; document.getElementById('editEntryTotal').textContent='₹0.00'; return; }
  container.innerHTML = `
    <table class="edit-items-table">
      <thead><tr><th style="width:40%;">Product</th><th style="width:18%;text-align:center;">Qty</th><th style="width:20%;text-align:center;">Rate (₹)</th><th style="width:22%;text-align:right;">Amount (₹)</th></tr></thead>
      <tbody>
        ${_editItems.map((item,idx) => `
          <tr>
            <td><input type="text" value="${item.name}" onchange="updateEditItem(${idx},'name',this.value)"></td>
            <td><input type="number" value="${item.qty}" min="0.01" step="0.01" style="text-align:center;" oninput="updateEditItem(${idx},'qty',this.value)"></td>
            <td><input type="number" value="${parseFloat(item.rate).toFixed(2)}" min="0" step="0.01" style="text-align:center;" oninput="updateEditItem(${idx},'rate',this.value)"></td>
            <td><input type="text" value="${parseFloat(item.amount).toFixed(2)}" readonly style="text-align:right;"></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  recalcEditTotal();
}

function updateEditItem(idx, field, value) {
  if (!_editItems[idx]) return;
  if (field==='name') { _editItems[idx].name=value; }
  else if (field==='qty') { _editItems[idx].qty=parseFloat(value)||0; _editItems[idx].amount=_editItems[idx].qty*(_editItems[idx].rate||0); }
  else if (field==='rate') { _editItems[idx].rate=parseFloat(value)||0; _editItems[idx].amount=(_editItems[idx].qty||0)*_editItems[idx].rate; }
  const rows = document.querySelectorAll('#editItemsContainer tbody tr');
  if (rows[idx]) { const amtInput=rows[idx].querySelectorAll('input')[3]; if(amtInput) amtInput.value=parseFloat(_editItems[idx].amount||0).toFixed(2); }
  recalcEditTotal();
}

function recalcEditTotal() {
  const total = _editItems.reduce((s,item)=>s+(parseFloat(item.amount)||0),0);
  document.getElementById('editEntryTotal').textContent='₹'+total.toFixed(2);
}

function saveEditEntry() {
  const e = state.ledger.find(x => x.id === state.editMode.id);
  if (!e) return;
  const dateVal = document.getElementById('editEntryDate').value;
  if (!dateVal) { toast('Please select a date', 'error'); return; }
  const d = new Date(dateVal+'T00:00:00');
  e.date = d.toLocaleDateString('en-IN',{day:'2-digit',month:'2-digit',year:'numeric'});
  e.description = document.getElementById('editEntryDesc').value.trim();
  e.items = _editItems.map(item => ({ name:item.name, qty:parseFloat(item.qty)||0, rate:parseFloat(item.rate)||0, amount:parseFloat(item.amount)||0 }));
  e.total = e.items.reduce((s,item)=>s+item.amount,0);
  save(); closeModal('editEntryModal'); renderLedger(); renderDashboard();
  toast('Entry updated', 'success');
}

function deleteEntry(id) {
  state.ledger = state.ledger.filter(e => e.id !== id);
  save(); renderLedger(); toast('Entry deleted');
}

function exportLedgerCSV() {
  const filter = document.getElementById('ledgerCustomerFilter').value;
  const invoices = filter ? state.ledger.filter(e=>String(e.customerId)===String(filter)) : state.ledger;
  const payments = filter ? (state.payments||[]).filter(p=>String(p.customerId)===String(filter)) : (state.payments||[]);
  const allRows = [];
  invoices.forEach(e => allRows.push({ type:'invoice', sortDate:parseDateIN(e.date), date:e.date, invoiceNo:e.invoiceNo, customerName:e.customerName, desc:[e.description,(e.items||[]).map(i=>i.name+'×'+i.qty).join('; ')].filter(Boolean).join(' - '), amount:e.total }));
  payments.forEach(p => {
    const ds = p.date?new Date(p.date+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'2-digit',year:'numeric'}):'-';
    const cn = (state.customers.find(c=>String(c.id)===String(p.customerId))||{}).name||'-';
    allRows.push({ type:'payment', sortDate:p.date?new Date(p.date+'T00:00:00'):new Date(0), date:ds, invoiceNo:'-', customerName:cn, desc:(p.note||'Payment'), amount:p.amount });
  });
  allRows.sort((a,b)=>a.sortDate-b.sortDate||(a.type==='invoice'?-1:1));
  let bal=0, csv='Date,Invoice No,Customer,Description,Debit (₹),Credit (₹),Balance (₹)\n';
  allRows.forEach(r => {
    if(r.type==='invoice'){bal+=r.amount;csv+=`"${r.date}","${r.invoiceNo}","${r.customerName}","${r.desc}","${r.amount.toFixed(2)}","","${bal.toFixed(2)}"\n`;}
    else{bal-=r.amount;csv+=`"${r.date}","-","${r.customerName}","${r.desc}","","${r.amount.toFixed(2)}","${Math.abs(bal).toFixed(2)}${bal<0?' CR':''}"\n`;}
  });
  const blob = new Blob([csv],{type:'text/csv'});
  const a = document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download='rajbills_ledger.csv'; a.click();
  toast('CSV exported!', 'success');
}

// ============================
// PRODUCTS PAGE
// ============================
function renderProductsPage() {
  const tbody = document.getElementById('productsBody');
  if (!state.products.length) { tbody.innerHTML='<tr><td colspan="5"><div class="empty-state"><div class="empty-state-icon">📦</div><div class="empty-state-text">No products added</div></div></td></tr>'; return; }
  tbody.innerHTML = state.products.map((p,i) => `
    <tr>
      <td style="color:var(--text-muted);font-size:12px;">${i+1}</td>
      <td><strong>${p.name}</strong></td>
      <td class="text-right mono text-red">${fmt(p.rate)}</td>
      <td><span class="badge badge-gray">${p.unit||'—'}</span></td>
      <td>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-secondary btn-sm" onclick="openEditProductModal(${p.id})">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="openDeleteModal('product',${p.id})">Del</button>
        </div>
      </td>
    </tr>`).join('');
}

function openAddProductModal() {
  state.editMode = { type:null, id:null };
  document.getElementById('productModalTitle').textContent='Add Product';
  document.getElementById('prodName').value=''; document.getElementById('prodRate').value=''; document.getElementById('prodUnit').value='';
  openModal('productModal');
}

function openEditProductModal(id) {
  const p = state.products.find(x=>x.id===id);
  state.editMode = { type:'product', id };
  document.getElementById('productModalTitle').textContent='Edit Product';
  document.getElementById('prodName').value=p.name; document.getElementById('prodRate').value=p.rate; document.getElementById('prodUnit').value=p.unit||'';
  openModal('productModal');
}

function saveProduct() {
  const name = document.getElementById('prodName').value.trim();
  const rate = parseFloat(document.getElementById('prodRate').value);
  const unit = document.getElementById('prodUnit').value.trim();
  if (!name||isNaN(rate)) { toast('Name and Rate are required', 'error'); return; }
  if (state.editMode.type==='product') {
    const p = state.products.find(x=>x.id===state.editMode.id);
    p.name=name; p.rate=rate; p.unit=unit; toast('Product updated','success');
  } else {
    state.products.push({ id:uid(), name, rate, unit }); toast('Product added','success');
  }
  save(); closeModal('productModal'); renderProductsPage();
}

// ============================
// CUSTOMERS PAGE
// ============================
function renderCustomersPage() {
  const tbody = document.getElementById('customersBody');
  if (!state.customers.length) { tbody.innerHTML='<tr><td colspan="6"><div class="empty-state"><div class="empty-state-icon">👥</div><div class="empty-state-text">No customers added</div></div></td></tr>'; return; }
  tbody.innerHTML = state.customers.map((c,i) => {
    const owCount = Object.keys(c.overwrites||{}).length;
    return `<tr>
      <td style="color:var(--text-muted);font-size:12px;">${i+1}</td>
      <td><strong>${c.name}</strong></td>
      <td style="font-size:12px;color:var(--text-muted);">${c.address||'—'}</td>
      <td style="font-size:12px;">${c.phone||'—'}</td>
      <td>${owCount?`<span class="badge badge-red">${owCount} special rate${owCount>1?'s':''}</span>`:'<span class="badge badge-gray">None</span>'}</td>
      <td>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-secondary btn-sm" onclick="openEditCustomerModal(${c.id})">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="openDeleteModal('customer',${c.id})">Del</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function openAddCustomerModal() {
  state.editMode={type:null,id:null}; state.tempOverwrites={};
  document.getElementById('customerModalTitle').textContent='Add Customer';
  ['custName','custAddress','custPhone'].forEach(id=>document.getElementById(id).value='');
  populateOwProductSelect(); renderTempOverwrites(); openModal('customerModal');
}

function openEditCustomerModal(id) {
  const c = state.customers.find(x=>x.id===id);
  state.editMode={type:'customer',id}; state.tempOverwrites={...(c.overwrites||{})};
  document.getElementById('customerModalTitle').textContent='Edit Customer';
  document.getElementById('custName').value=c.name;
  document.getElementById('custAddress').value=c.address||'';
  document.getElementById('custPhone').value=c.phone||'';
  populateOwProductSelect(); renderTempOverwrites(); openModal('customerModal');
}

function populateOwProductSelect() {
  const sel = document.getElementById('owProduct');
  sel.innerHTML = state.products.map(p => `<option value="${p.id}">${p.name} (₹${p.rate})</option>`).join('');
}

function addOverwrite() {
  const prodId = document.getElementById('owProduct').value;
  const rate   = parseFloat(document.getElementById('owRate').value);
  if (!prodId||isNaN(rate)) { toast('Select product and enter rate','error'); return; }
  state.tempOverwrites[prodId]=rate; document.getElementById('owRate').value='';
  renderTempOverwrites();
}

function renderTempOverwrites() {
  const el = document.getElementById('overwrites');
  const entries = Object.entries(state.tempOverwrites);
  if (!entries.length) { el.innerHTML='<div style="font-size:12px;color:var(--text-muted);padding:6px 0;">No special rates set</div>'; return; }
  el.innerHTML = entries.map(([pid,rate]) => {
    const p = state.products.find(x=>String(x.id)===String(pid));
    return p?`<div class="overwrite-item"><span class="ow-product">${p.name}</span><span style="font-size:11px;color:var(--text-muted);">Default: ₹${p.rate} →</span><span class="ow-price">₹${parseFloat(rate).toFixed(2)}</span><button class="btn btn-danger btn-sm" onclick="removeOverwrite(${pid})">✕</button></div>`:''
  }).join('');
}

function removeOverwrite(pid) { delete state.tempOverwrites[pid]; renderTempOverwrites(); }

function saveCustomer() {
  const name = document.getElementById('custName').value.trim();
  if (!name) { toast('Customer name is required','error'); return; }
  const address = document.getElementById('custAddress').value.trim();
  const phone   = document.getElementById('custPhone').value.trim();
  if (state.editMode.type==='customer') {
    const c = state.customers.find(x=>x.id===state.editMode.id);
    c.name=name; c.address=address; c.phone=phone; c.overwrites={...state.tempOverwrites};
    toast('Customer updated','success');
  } else {
    state.customers.push({ id:uid(), name, address, phone, overwrites:{...state.tempOverwrites} });
    toast('Customer added','success');
  }
  save(); closeModal('customerModal'); renderCustomerList(); renderCustomersPage();
}

// ============================
// DELETE
// ============================
function openDeleteModal(type, id) {
  state.pendingDelete={type,id};
  const msgs={product:'Delete this product? This cannot be undone.',customer:'Delete this customer? All overwrites will be lost.'};
  document.getElementById('deleteModalMsg').textContent=msgs[type];
  openModal('deleteModal');
}

function confirmDelete() {
  const {type,id} = state.pendingDelete;
  if (type==='product') { state.products=state.products.filter(p=>p.id!==id); toast('Product deleted'); renderProductsPage(); }
  else if (type==='customer') {
    if (state.selectedCustomer===id) {
      state.selectedCustomer=null;
      document.getElementById('selectedCustomerBanner').style.display='none';
      document.getElementById('noCustomerMsg').style.display='block';
      document.getElementById('invoiceBuilderCard').style.display='none';
    }
    state.customers=state.customers.filter(c=>c.id!==id); toast('Customer deleted');
    renderCustomerList(); renderCustomersPage();
  }
  save(); closeModal('deleteModal');
}

// ============================
// INIT
// ============================
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', function(e) { if (e.target===this) this.classList.remove('open'); });
});

renderCustomerList();
showPage('dashboard');

document.getElementById('dashPeriod').addEventListener('change', function() {
  const crp = document.getElementById('customRangePicker');
  if (crp) crp.style.display = this.value==='custom'?'flex':'none';
  if (this.value!=='custom') renderDashboard();
});

window.addEventListener('load', function() {
  if (DRIVE_CLIENT_ID && _gapiReady) tryAutoReconnectDrive();
  else if (DRIVE_CLIENT_ID) {
    setTimeout(() => { if (_gapiReady) tryAutoReconnectDrive(); }, 2000);
  }
});
