// ============================
// LEDGER PAGE — SELECTION MODE (NEW v2.1)
// ============================
let _selectionMode = false;
let _selectedRows  = new Set();

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

// NEW: Centralized click handler for rows
function handleRowClick(e, id) {
  if (!_selectionMode) return;
  // Don't select the row if the user clicks a delete/view button
  if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
  toggleRowSelection(id);
}

function toggleRowSelection(id) {
  const sid = String(id);
  if (_selectedRows.has(sid)) _selectedRows.delete(sid);
  else _selectedRows.add(sid);
  
  // Instantly update UI without re-rendering the whole table
  document.querySelectorAll(`tr[data-id="${sid}"], .ledger-card[data-id="${sid}"]`).forEach(el => {
    el.classList.toggle('selected-row', _selectedRows.has(sid));
    const chk = el.querySelector('input[type="checkbox"]');
    if (chk) chk.checked = _selectedRows.has(sid);
  });

  updateSelectionCount();
  updateSelectAllCheckbox();
}

function selectAllVisible() {
  const cards = document.querySelectorAll('.ledger-card[data-id]');
  const rows  = document.querySelectorAll('#ledgerBody tr[data-id]');
  const allIds = [...new Set([...cards, ...rows].map(el => el.getAttribute('data-id')))];
  
  const allSelected = allIds.length > 0 && allIds.every(id => _selectedRows.has(id));
  
  if (allSelected) {
    allIds.forEach(id => _selectedRows.delete(id));
  } else {
    allIds.forEach(id => _selectedRows.add(id));
  }
  
  // Visually sync all rows instantly
  allIds.forEach(id => {
    document.querySelectorAll(`tr[data-id="${id}"], .ledger-card[data-id="${id}"]`).forEach(el => {
      el.classList.toggle('selected-row', _selectedRows.has(id));
      const chk = el.querySelector('input[type="checkbox"]');
      if (chk) chk.checked = _selectedRows.has(id);
    });
  });

  updateSelectionCount();
  updateSelectAllCheckbox();
}

function updateSelectAllCheckbox() {
  ['selAllCheckbox', 'selAllCheckboxDesktop'].forEach(chkId => {
    const chk = document.getElementById(chkId);
    if (chk && _selectionMode) {
      const cards = document.querySelectorAll('.ledger-card[data-id]');
      const rows  = document.querySelectorAll('#ledgerBody tr[data-id]');
      const allIds = [...new Set([...cards, ...rows].map(el => el.getAttribute('data-id')))];
      
      if (allIds.length === 0) {
        chk.checked = false; chk.indeterminate = false; return;
      }
      const selectedCount = allIds.filter(id => _selectedRows.has(id)).length;
      chk.checked = selectedCount === allIds.length;
      chk.indeterminate = selectedCount > 0 && selectedCount < allIds.length;
    }
  });
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

  // Checkbox is now completely passive (pointer-events:none)
  const selChkTd = (rowId) => _selectionMode
    ? `<td style="width:36px;text-align:center;"><label class="sel-checkbox" style="pointer-events:none;"><input type="checkbox" ${_selectedRows.has(String(rowId))?'checked':''}><span class="sel-checkmark"></span></label></td>`
    : '';

  tbody.innerHTML = allRows.map(row => {
    const isSel = _selectedRows.has(String(row.id));
    if (row.type==='payment') {
      // Added cursor and handleRowClick to TR
      return `<tr style="background:#f0fff4; cursor:${_selectionMode?'pointer':''}" data-id="${row.id}" class="${isSel?'selected-row':''}" onclick="handleRowClick(event, '${row.id}')">
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
      // Added cursor and handleRowClick to TR
      return `<tr style="cursor:${_selectionMode?'pointer':''}" data-id="${row.id}" class="${isSel?'selected-row':''}" onclick="handleRowClick(event, '${row.id}')">
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

  const selAllTh = document.getElementById('selAllTh');
  if (selAllTh) selAllTh.style.display = _selectionMode ? 'table-cell' : 'none';
  
  const cards = document.getElementById('ledgerCards');
  cards.innerHTML = allRows.map(row => {
    const isPay = row.type === 'payment';
    const amtClass = isPay ? 'credit' : 'debit';
    const itemsStr = (row.items||[]).map(i=>i.name+'×'+i.qty).join(', ');
    const fullDesc = isPay ? row.desc : [row.desc, itemsStr].filter(Boolean).join(' — ');
    const isSel = _selectedRows.has(String(row.id));
    
    // Mobile Checkbox is passive
    const selCheckHTML = _selectionMode
      ? `<label class="sel-checkbox" style="margin-right:8px;margin-top:2px;flex-shrink:0;pointer-events:none;"><input type="checkbox" ${isSel?'checked':''}><span class="sel-checkmark"></span></label>`
      : '';
      
    const actionsHTML = isPay
      ? `<button class="btn btn-danger btn-sm" onclick="deletePaymentRow(${row.id})">✕ Delete</button>`
      : `<button class="btn btn-info btn-sm" onclick="openInvoicePreview(${row.id})">👁 View</button>
         <button class="btn btn-secondary btn-sm" onclick="openEditEntryModal(${row.id})">✏️ Edit</button>
         <button class="btn btn-danger btn-sm" onclick="deleteEntry(${row.id})">🗑 Del</button>`;
         
    return `<div class="ledger-card ${isPay?'pay-card':''} ${isSel?'selected-row':''}" data-id="${row.id}" style="cursor:${_selectionMode?'pointer':''}" onclick="handleRowClick(event, '${row.id}')">
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

  updateSelectAllCheckbox();
}
