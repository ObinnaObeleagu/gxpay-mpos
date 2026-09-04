/**
 * transactions.js
 * ---------------------------------------------------------------------------
 * Powers two tabs plus the checkout screen's cart:
 *   - "Transactions": lists everything recorded (GET /api/payments), with
 *     view/reprint/re-download for any past receipt
 *   - "Items": the sale/service catalog (GET/POST/PATCH/DELETE
 *     /api/catalog) - add, edit, delete items and their prices
 *   - The Checkout tab's cart: pick items from the same catalog, adjust
 *     quantity, add multiple different items to a running cart with a
 *     total shown below - see addToCart()/removeFromCart()/renderCart().
 *     Charging with a non-empty cart sends items[] to the backend, which
 *     computes the authoritative total and an itemized receipt server-side
 *     (see routes/payments.js) - this module's cart total is for the
 *     operator's benefit, not the source of truth for what actually gets
 *     charged.
 *
 * Kept as its own module, separate from paymentProcessor.js, since it's a
 * distinct concern (browsing history / catalog management / cart-building
 * vs. running a live transaction).
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  const state = {
    filter: '',
    transactions: [],
    currentReceipt: null,
    catalogItems: [],
    editingItemId: null,
    cart: [], // [{ itemId, name, unitPrice, currency, qty }]
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

  function formatMoney(currency, amount) {
    const n = Number(amount);
    return `${currency} ${Number.isNaN(n) ? amount : n.toFixed(2)}`;
  }

  /** Renders a receipt's itemized cart rows (when present) as HTML - shared
   *  by both the live checkout receipt panel (paymentProcessor.js) and the
   *  Transactions tab's receipt modal below, so a multi-item receipt looks
   *  identical in both places. */
  function renderReceiptItemsHtml(receipt) {
    if (!receipt.items || !receipt.items.length) return '';
    const rows = receipt.items
      .map(
        (item) => `<div class="gx-receipt-row">
          <span class="label">${escapeHtml(item.qty)} &times; ${escapeHtml(item.name)}</span>
          <span class="value">${escapeHtml(formatMoney(receipt.currency, item.lineTotal))}</span>
        </div>`
      )
      .join('');
    return `<div class="gx-receipt-items"><div class="gx-receipt-items-label">Items</div>${rows}</div>`;
  }

  // ---- tab switching ------------------------------------------------------
  function switchTab(tab) {
    $('checkout-view').style.display = tab === 'checkout' ? 'flex' : 'none';
    $('transactions-view').style.display = tab === 'transactions' ? 'flex' : 'none';
    $('items-view').style.display = tab === 'items' ? 'flex' : 'none';

    ['checkout', 'transactions', 'items'].forEach((t) => {
      const btn = $(`tab-${t}`);
      const active = t === tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });

    if (tab === 'transactions') load();
    if (tab === 'items') loadCatalog();
  }

  // ---- transactions list --------------------------------------------------
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
        const descriptor = t.description ? `<div style="font-size:11px; color:var(--ink-soft); margin-top:2px;">${escapeHtml(t.description)}</div>` : '';
        return `<tr>
          <td>${escapeHtml(formatDateTime(t.createdAt))}</td>
          <td class="gx-table-mono">${escapeHtml(t.reference)}${descriptor}</td>
          <td>${escapeHtml(formatMoney(t.currency, t.amount))}</td>
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

  // ---- receipt view / reprint / re-download --------------------------------
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

    const descriptionEl = $('tx-receipt-description');
    if (descriptionEl) {
      if (receipt.description) {
        descriptionEl.textContent = receipt.description;
        descriptionEl.style.display = '';
      } else {
        descriptionEl.style.display = 'none';
      }
    }

    const rows = [
      ['Merchant', receipt.merchant],
      ['Terminal', receipt.terminalId],
      ['Reference', receipt.reference],
      ['Amount', formatMoney(receipt.currency, receipt.amount)],
      ['Card', `${receipt.cardScheme || ''} ${receipt.card}`.trim()],
      ['Entry Mode', receipt.entryMode],
      ['Auth Code', receipt.authCode || '-'],
      ['RRN', receipt.rrn || '-'],
      ['Gateway Ref', receipt.gatewayReference || '-'],
      ['Status', (receipt.status || '').toUpperCase()],
      ['Message', receipt.responseMessage || '-'],
      ['Time', new Date(receipt.timestamp).toLocaleString()],
    ];

    const itemsHtml = renderReceiptItemsHtml(receipt);
    const rowsHtml = rows
      .map(([label, value]) => `<div class="gx-receipt-row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(String(value))}</span></div>`)
      .join('');
    $('tx-receipt-body').innerHTML = itemsHtml + rowsHtml;
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

  // ---- catalog: shared load (powers both the checkout cart picker and the
  // Items tab's table) ------------------------------------------------------
  async function loadCatalog() {
    try {
      const res = await fetch('/api/catalog');
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      state.catalogItems = data.items || [];
      populateCatalogPicker();
      renderItemsTable();
    } catch (err) {
      const tbody = $('items-tbody');
      if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="gx-table-empty">Could not load items: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function populateCatalogPicker() {
    const select = $('catalog-item-select');
    if (!select) return;
    const previousValue = select.value;
    const sale = state.catalogItems.filter((i) => i.type === 'sale');
    const service = state.catalogItems.filter((i) => i.type === 'service');

    function optionsFor(items) {
      return items
        .map((i) => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)} &mdash; ${escapeHtml(formatMoney(i.currency, i.price))}</option>`)
        .join('');
    }

    select.innerHTML =
      '<option value="">Select an item...</option>' +
      (sale.length ? `<optgroup label="Sale items">${optionsFor(sale)}</optgroup>` : '') +
      (service.length ? `<optgroup label="Services">${optionsFor(service)}</optgroup>` : '');

    if (previousValue && state.catalogItems.some((i) => i.id === previousValue)) {
      select.value = previousValue;
    }
  }

  // ---- checkout cart --------------------------------------------------------
  function addToCart() {
    const select = $('catalog-item-select');
    const qtyInput = $('catalog-item-qty');
    if (!select || !select.value) {
      // eslint-disable-next-line no-alert
      alert('Select an item first.');
      return;
    }
    const item = state.catalogItems.find((i) => i.id === select.value);
    if (!item) return;
    const qty = Math.max(1, parseInt((qtyInput && qtyInput.value) || '1', 10) || 1);

    const existing = state.cart.find((line) => line.itemId === item.id);
    if (existing) {
      existing.qty += qty;
    } else {
      state.cart.push({ itemId: item.id, name: item.name, unitPrice: Number(item.price), currency: item.currency, qty });
    }

    // Reset the picker for adding the next item, cleanly.
    select.value = '';
    if (qtyInput) qtyInput.value = '1';

    renderCart();
  }

  function removeFromCart(index) {
    state.cart.splice(index, 1);
    renderCart();
  }

  function clearCart() {
    state.cart = [];
    renderCart();
  }

  function getCartTotal() {
    return state.cart.reduce((sum, line) => sum + line.unitPrice * line.qty, 0);
  }

  /** Called from paymentProcessor.js's checkout() to build the items[]
   *  field for POST /api/payments/charge. Returns undefined when the cart
   *  is empty (plain custom-amount charge, unchanged from before this
   *  feature existed). */
  function getCartItemsForCharge() {
    if (!state.cart.length) return undefined;
    return state.cart.map((line) => ({ name: line.name, unitPrice: line.unitPrice, qty: line.qty }));
  }

  function renderCart() {
    const section = $('cart-section');
    const rowsEl = $('cart-rows');
    const totalEl = $('cart-total-display');
    const amountInput = $('Amount');
    const currencySelect = $('currency_code');
    if (!section || !rowsEl || !totalEl) return;

    if (!state.cart.length) {
      section.style.display = 'none';
      if (amountInput) {
        amountInput.readOnly = false;
        amountInput.value = '';
      }
      return;
    }

    section.style.display = 'block';
    rowsEl.innerHTML = state.cart
      .map(
        (line, index) => `<div class="gx-cart-row">
          <div class="gx-cart-row-info">
            <span class="gx-cart-row-name">${escapeHtml(line.name)}</span>
            <span class="gx-cart-row-qty">Qty: ${escapeHtml(line.qty)}</span>
          </div>
          <span class="gx-cart-row-price">${escapeHtml(formatMoney(line.currency, line.unitPrice * line.qty))}</span>
          <button type="button" class="gx-cart-row-remove" onclick="Transactions.removeFromCart(${index})" aria-label="Remove ${escapeHtml(line.name)}">&times;</button>
        </div>`
      )
      .join('');

    const total = getCartTotal();
    const cartCurrency = state.cart[0].currency;
    totalEl.textContent = formatMoney(cartCurrency, total);

    // Sync the currency dropdown to the cart's currency (all lines are
    // assumed to share one - mixing currencies in a single cart isn't a
    // sensible real-world scenario, so this isn't specially handled beyond
    // following whatever the first item added was priced in).
    if (currencySelect) {
      const match = Array.from(currencySelect.options).find((o) => o.getAttribute('data-alpha') === cartCurrency);
      if (match) currencySelect.value = match.value;
    }

    // The Amount field becomes read-only and auto-synced to the cart total
    // while the cart has items - see the note on checkAmount()'s
    // decimal-point rejection below for why String(), not toFixed(2).
    if (amountInput) {
      amountInput.readOnly = true;
      // The Dspread SDK's own checkAmount() (main.js) hard-rejects any
      // amount string containing a "." with INPUT_INVALID_FORMAT -
      // confirmed via real-device testing (see the single-item picker's
      // original fix for this exact bug). String(total) matches the
      // decimal-free format a human typing a whole-number amount produces
      // naturally. Fractional cart totals (e.g. from a unit price with
      // kobo) would still hit the device's own restriction - a genuine
      // hardware/SDK limit, not fixable from this side.
      amountInput.value = String(total);
    }
  }

  // ---- items tab: table + add/edit/delete ----------------------------------
  function renderItemsTable() {
    const tbody = $('items-tbody');
    if (!tbody) return;
    if (!state.catalogItems.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="gx-table-empty">No items yet - add one above.</td></tr>';
      return;
    }
    tbody.innerHTML = state.catalogItems
      .map(
        (i) => `<tr>
          <td>${escapeHtml(i.name)}</td>
          <td><span class="gx-table-badge ${i.type === 'service' ? 'pending' : 'approved'}">${escapeHtml(i.type.toUpperCase())}</span></td>
          <td>${escapeHtml(formatMoney(i.currency, i.price))}</td>
          <td class="gx-table-actions">
            <button type="button" class="gx-btn-link" onclick="Transactions.editItem('${escapeHtml(i.id)}')">Edit</button>
            <button type="button" class="gx-btn-link" style="color:var(--danger); margin-left:10px;" onclick="Transactions.deleteItem('${escapeHtml(i.id)}')">Delete</button>
          </td>
        </tr>`
      )
      .join('');
  }

  function editItem(id) {
    const item = state.catalogItems.find((i) => i.id === id);
    if (!item) return;
    state.editingItemId = id;
    $('item-name').value = item.name;
    $('item-price').value = item.price;
    $('item-type').value = item.type;
    $('item-currency').value = item.currency;
    $('item-form-submit-label').textContent = 'Save changes';
    $('item-form-cancel-wrap').style.display = '';
    $('item-name').focus();
  }

  function cancelItemEdit() {
    state.editingItemId = null;
    $('item-form').reset();
    $('item-form-submit-label').textContent = 'Add item';
    $('item-form-cancel-wrap').style.display = 'none';
  }

  async function submitItemForm(event) {
    event.preventDefault();
    const name = $('item-name').value.trim();
    const price = $('item-price').value;
    const type = $('item-type').value;
    const currency = $('item-currency').value;

    if (!name || price === '' || Number(price) < 0) {
      // eslint-disable-next-line no-alert
      alert('Enter a name and a valid (non-negative) price.');
      return false;
    }

    const editingId = state.editingItemId;
    const url = editingId ? `/api/catalog/${encodeURIComponent(editingId)}` : '/api/catalog';
    const method = editingId ? 'PATCH' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, price: Number(price), type, currency }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data.errors && data.errors.join(', ')) || data.message || `HTTP ${res.status}`);
      cancelItemEdit();
      await loadCatalog();
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Could not save item: ${err.message}`);
    }
    return false;
  }

  async function deleteItem(id) {
    const item = state.catalogItems.find((i) => i.id === id);
    // eslint-disable-next-line no-alert
    if (!confirm(`Delete "${item ? item.name : 'this item'}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/catalog/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      if (state.editingItemId === id) cancelItemEdit();
      await loadCatalog();
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Could not delete item: ${err.message}`);
    }
  }

  global.Transactions = {
    switchTab,
    setFilter,
    load,
    viewReceipt,
    printCurrentReceipt,
    downloadCurrentReceiptPdf,
    loadCatalog,
    addToCart,
    removeFromCart,
    clearCart,
    getCartItemsForCharge,
    renderReceiptItemsHtml,
    editItem,
    cancelItemEdit,
    submitItemForm,
    deleteItem,
  };

  // Populate the checkout cart's item picker as soon as the page loads (not
  // just when the Items tab is opened), since the Checkout tab is the
  // default view and its picker needs the same data immediately.
  document.addEventListener('DOMContentLoaded', loadCatalog);
})(window);
