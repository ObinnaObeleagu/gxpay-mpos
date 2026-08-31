/**
 * transactions.js
 * ---------------------------------------------------------------------------
 * The "Transactions" tab: lists every transaction the backend has recorded
 * (GET /api/payments - store/transactionStore.js on the Node backend),
 * lets the operator filter by status, and view/reprint/re-download the
 * receipt for any past transaction (GET /api/payments/:reference/status
 * for the full receipt, GET /api/payments/:reference/receipt.pdf for the
 * PDF - both already existed for the live checkout flow; this reuses them
 * rather than adding new endpoints).
 *
 * Kept as its own module, separate from paymentProcessor.js, since it's a
 * distinct concern (browsing history vs. running a live transaction) and
 * intentionally doesn't touch any in-progress checkout state.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  const state = {
    filter: '',
    transactions: [],
    currentReceipt: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function formatDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  // ---- tab switching --------------------------------------------------
  function switchTab(tab) {
    const isCheckout = tab === 'checkout';
    $('checkout-view').style.display = isCheckout ? 'flex' : 'none';
    $('transactions-view').style.display = isCheckout ? 'none' : 'flex';

    $('tab-checkout').classList.toggle('active', isCheckout);
    $('tab-checkout').setAttribute('aria-selected', String(isCheckout));
    $('tab-transactions').classList.toggle('active', !isCheckout);
    $('tab-transactions').setAttribute('aria-selected', String(!isCheckout));

    if (!isCheckout) load();
  }

  // ---- list -------------------------------------------------------------
  function setFilter(status) {
    state.filter = status;
    load();
  }

  async function load() {
    const tbody = $('transactions-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="gx-table-empty">Loading&hellip;</td></tr>';
    try {
      const qs = state.filter ? `?status=${encodeURIComponent(state.filter)}` : '';
      const res = await fetch(`/api/payments${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      state.transactions = data.transactions || [];
      render();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="gx-table-empty">Could not load transactions: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function render() {
    const tbody = $('transactions-tbody');
    if (!state.transactions.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="gx-table-empty">No transactions yet.</td></tr>';
      return;
    }
    tbody.innerHTML = state.transactions
      .map((t) => {
        const statusClass = t.status === 'approved' ? 'approved' : t.status === 'declined' ? 'declined' : t.status === 'error' ? 'error' : 'pending';
        return `<tr>
          <td>${escapeHtml(formatDateTime(t.createdAt))}</td>
          <td class="gx-table-mono">${escapeHtml(t.reference)}</td>
          <td>${escapeHtml(t.currency)} ${escapeHtml(t.amount)}</td>
          <td>${escapeHtml(t.card || '-')}</td>
          <td><span class="gx-table-badge ${statusClass}">${escapeHtml((t.status || '').toUpperCase())}</span></td>
          <td class="gx-table-actions">
            <button type="button" class="gx-btn-link" onclick="Transactions.viewReceipt('${escapeHtml(t.reference)}')" ${t.hasReceipt ? '' : 'disabled'}>
              View
            </button>
          </td>
        </tr>`;
      })
      .join('');
  }

  // ---- receipt view / reprint / re-download ------------------------------
  async function viewReceipt(reference) {
    try {
      const res = await fetch(`/api/payments/${encodeURIComponent(reference)}/status`);
      const data = await res.json();
      if (!res.ok || !data.receipt) {
        throw new Error(data.message || 'No receipt available for this transaction.');
      }
      state.currentReceipt = data.receipt;
      renderReceiptModal(data.receipt);
      global.openModal('transactionReceiptModal');
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Could not load receipt: ${err.message}`);
    }
  }

  function renderReceiptModal(receipt) {
    const approved = receipt.status === 'approved';
    const badge = $('tx-receipt-status-badge');
    badge.textContent = approved ? 'Approved' : (receipt.status || '').charAt(0).toUpperCase() + (receipt.status || '').slice(1);
    badge.className = `gx-receipt-status ${approved ? 'approved' : receipt.status}`;

    const rows = [
      ['Merchant', receipt.merchant],
      ['Terminal', receipt.terminalId],
      ['Reference', receipt.reference],
      ['Amount', `${receipt.currency} ${receipt.amount}`],
      ['Card', `${receipt.cardScheme || ''} ${receipt.card}`.trim()],
      ['Entry Mode', receipt.entryMode],
      ['Auth Code', receipt.authCode || '-'],
      ['RRN', receipt.rrn || '-'],
      ['Gateway Ref', receipt.gatewayReference || '-'],
      ['Status', (receipt.status || '').toUpperCase()],
      ['Message', receipt.responseMessage || '-'],
      ['Time', new Date(receipt.timestamp).toLocaleString()],
    ];

    $('tx-receipt-body').innerHTML = rows
      .map(([label, value]) => `<div class="gx-receipt-row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(String(value))}</span></div>`)
      .join('');
  }

  function printCurrentReceipt() {
    window.print();
  }

  function downloadCurrentReceiptPdf() {
    if (!state.currentReceipt) return;
    const reference = state.currentReceipt.reference;
    const a = document.createElement('a');
    a.href = `/api/payments/${encodeURIComponent(reference)}/receipt.pdf`;
    a.download = `gxpay-receipt-${reference}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  global.Transactions = {
    switchTab,
    setFilter,
    load,
    viewReceipt,
    printCurrentReceipt,
    downloadCurrentReceiptPdf,
  };
})(window);
