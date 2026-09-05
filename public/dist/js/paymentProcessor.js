/**
 * paymentProcessor.js
 * ---------------------------------------------------------------------------
 * Payment processing for the CR100-SCRP checkout page.
 *
 * This module owns everything from "operator clicks Checkout" through
 * "receipt is shown and status is confirmed". It is deliberately kept
 * separate from Script.js (which owns the low-level Dspread SDK/device
 * wiring - connect, EMV config updates, firmware updates, etc.) so the
 * payment flow is easy to find and audit on its own.
 *
 * Script.js calls into this module at these points (see the edits in
 * Script.js's QPOSServiceListenerImpl.prototype.* handlers):
 *
 *   onRequestWaitingUser   -> PaymentProcessor.onWaitingForCard()
 *   onRequestOnlineProcess -> PaymentProcessor.onOnlineAuthorizationRequest(msg, sendResult)
 *                             (THIS is where chip/EMV transactions actually
 *                             get authorized against GxPay - the original
 *                             demo hardcoded an approval here and never
 *                             contacted a gateway at all)
 *   onDoTradeResult (MCR / NFC_ONLINE) -> PaymentProcessor.onCardRead(entryMode, trackFields)
 *   onDoTradeResult (ICC)              -> PaymentProcessor.onTradeComplete('ICC')
 *                             CAUTION: despite the SDK's naming, this fires
 *                             the moment a chip is first detected - BEFORE
 *                             EMV processing even starts, not after. It is
 *                             not the transaction's real completion signal
 *                             for ICC - see onRequestTransactionResult below.
 *   onRequestTransactionResult('APPROVED') -> PaymentProcessor.onTransactionApproved()
 *                             This is the ACTUAL final completion signal for
 *                             a chip transaction (confirmed via real-device
 *                             trace logs) - it fires once the terminal has
 *                             finished its cryptogram exchange with the card,
 *                             well after onOnlineAuthorizationRequest already
 *                             got a result from GxPay. Every other outcome
 *                             (DECLINED/TERMINATED/CANCEL/DEVICE_ERROR) comes
 *                             through the same callback and is handled in
 *                             Script.js via PaymentProcessor.onDeviceError().
 *
 * Card data handling: this module never puts a full PAN, full track, or PIN
 * block into the DOM. Only entryMode + already-encrypted material (KSN +
 * DUKPT/3DES ciphertext, or EMV TLV tags) is sent to our own backend over
 * HTTPS, which is the only thing allowed to talk to GxPay. See
 * README-PAYMENT-INTEGRATION.md, "Security & PCI notes".
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  const state = {
    pending: null, // { reference, amount, currency, currencyNumeric, transactionType }
    lastResult: null, // last receipt shown, for Confirm Status / Print
  };

  // ---- small DOM helpers ---------------------------------------------------
  function $(id) {
    return document.getElementById(id);
  }

  function setCardStatus(kind, text) {
    const el = $('card-status');
    const label = $('card-status-text');
    if (!el) return;
    el.classList.remove('status-waiting', 'status-detected', 'status-error', 'status-processing');
    // approved -> the green "detected" styling; declined -> the red "error"
    // styling. (These used to both map to "detected", which meant a
    // declined transaction incorrectly showed the green success color.)
    const cssKind = { approved: 'detected', declined: 'error' }[kind] || kind;
    if (kind !== 'idle') el.classList.add(`status-${cssKind}`);
    if (label) label.textContent = text;
  }

  /**
   * Append-only diagnostic trace, timestamped, shown in the "Transaction
   * status" feed. This keeps the full sequence of what actually happened on
   * screen - essential for diagnosing hardware-side failures (like an
   * undocumented DEVICE_ERROR) without needing the browser console open.
   */
  function trace(label, detail) {
    const el = $('result_div');
    if (!el) return;
    const time = new Date().toLocaleTimeString([], { hour12: false });
    const line = detail ? `[${time}] ${label} - ${detail}` : `[${time}] ${label}`;
    console.log(`[PaymentProcessor trace] ${line}`);
    if (el.dataset.traceStarted !== '1') {
      el.textContent = '';
      el.dataset.traceStarted = '1';
    }
    el.textContent += (el.textContent ? '\n' : '') + line;
    el.scrollTop = el.scrollHeight;
  }

  function resetTrace() {
    const el = $('result_div');
    if (el) {
      el.textContent = '';
      el.dataset.traceStarted = '1';
    }
  }

  function selectedCurrency() {
    const select = $('currency_code');
    const opt = select && select.options[select.selectedIndex];
    return {
      numeric: select ? select.value : '0840',
      alpha: opt ? opt.getAttribute('data-alpha') || 'USD' : 'USD',
    };
  }

  function generateReference() {
    if (global.crypto && global.crypto.randomUUID) {
      return `WEB-${global.crypto.randomUUID()}`;
    }
    return `WEB-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }

  // ---- checkout entry point (called by the "Checkout / Pay" button) -------
  function checkout() {
    const amountInput = $('Amount');
    const amount = parseFloat(amountInput && amountInput.value);
    const checkoutBtn = $('checkout-btn');

    if (!amount || amount <= 0) {
      setCardStatus('error', 'Enter a valid amount before checking out.');
      if (amountInput) amountInput.focus();
      return;
    }

    if (typeof Connected === 'undefined' || !Connected) {
      setCardStatus('error', 'Card reader is not connected. Click "Connect" in the top navigation first.');
      return;
    }

    hideReceipt();
    const currency = selectedCurrency();
    const transactionTypeSelect = $('TractionType');

    state.pending = {
      reference: generateReference(),
      amount: amount.toFixed(2),
      currencyAlpha: currency.alpha,
      currencyNumeric: currency.numeric,
      // Set by the Checkout tab's cart (Transactions.getCartItemsForCharge())
      // when the operator added one or more catalog items rather than
      // typing a custom amount - see public/dist/js/transactions.js.
      // Undefined for a plain custom-amount charge (empty cart), which is
      // fine - the backend treats a missing items[] as optional and the
      // charge behaves exactly as it did before this feature existed.
      items: (global.Transactions && global.Transactions.getCartItemsForCharge) ? global.Transactions.getCartItemsForCharge() : undefined,
    };

    resetTrace();
    trace('Checkout started', `amount=${amount.toFixed(2)} ${currency.alpha}, type=${transactionTypeSelect ? transactionTypeSelect.value : '10'}`);
    setCardStatus('waiting', 'Preparing card reader...');
    if (checkoutBtn) checkoutBtn.disabled = true;

    // Delegates to the existing Dspread SDK wiring in Script.js, which
    // calls mService.setAmount(...) and mService.doTrade(...). Card
    // presentment (insert/swipe/tap) then drives the
    // onRequestWaitingUser / onRequestOnlineProcess / onDoTradeResult
    // callbacks this module hooks. Pass the raw typed string (not the
    // reformatted float) to the device SDK, matching what
    // setAmount()/doTrade() expect.
    //
    // NOTE: an earlier version of this function called
    // mService.resetPosStatus() here first, as a speculative precaution
    // against stale session state. Trace log evidence from real hardware
    // showed that "reset" call's own acknowledgment gets misclassified by
    // the SDK's generic response dispatcher as onError(DEVICE_RESET), and
    // - worse - the subsequent doTrade() call (fired only 200ms later) was
    // very likely still landing while the device was internally settling
    // from that reset, triggering a CMDID_DESTRUCT ("DEVICE_ERROR") abort
    // almost immediately, before a card could physically be presented. That
    // speculative fix is removed - doTrade() is called directly, matching
    // the original stock demo's behavior.
    global.startTrade(amountInput.value, currency.numeric, transactionTypeSelect ? transactionTypeSelect.value : '10');
  }

  // ---- callbacks invoked from Script.js's QPOSServiceListenerImpl ---------

  function onWaitingForCard() {
    setCardStatus('waiting', 'Please insert, swipe, or tap your card now.');
    trace('Waiting for card');
  }

  /**
   * Chip (ICC) transactions: this fires when the device has produced the EMV
   * online-authorization request (TLV tags including amount, cryptogram
   * request (ARQC), etc.) and needs an authorization response before it can
   * complete the chip transaction. This is the actual "call GxPay" moment
   * for chip cards - the original demo skipped this and always replied with
   * a hardcoded approval, which is not safe.
   *
   * `sendResult(tlvHexString)` must be called exactly once with the TLV the
   * SDK expects (see buildOnlineAuthTlv() below) to let the device finish
   * the EMV exchange - do not leave the terminal hanging.
   */
  /**
   * Builds the reply the Dspread EMV kernel expects for an online-authorized
   * chip transaction: tag 8A (Authorization Response Code). Confirmed
   * against three independent current Dspread reference implementations
   * (Android SDK v8.4.9, iOS demo, and the original Android readMe) - all
   * three send exactly "8A02" + responseCode with nothing else appended:
   *
   *   pos.sendOnlineProcessResult("8A023030");  // Android reference demo
   *
   * An earlier version of this function also appended tag 91 (ARPC) based
   * on a different/older doc snippet - that was reverted. A real ARPC is
   * cryptographically derived by the issuer from the card's specific ARQC;
   * a synthetic placeholder is not just unnecessary but could actively be
   * rejected by a kernel that validates it, so we only ever send tag 8A.
   * If GxPay's real response includes a genuine ARPC and transactions still
   * fail without it on your specific terminal/EMV config, tag 91 support
   * can be re-added - but start from this confirmed-minimal reply.
   */
  function buildOnlineAuthTlv(approved) {
    return approved ? '8A023030' : '8A023035';
  }

  function onOnlineAuthorizationRequest(emvRequestTlvHex, sendResult) {
    trace('Chip inserted - device requested online authorization', `${emvRequestTlvHex ? emvRequestTlvHex.length : 0} hex chars of EMV data`);

    if (!state.pending) {
      // Defensive: device asked for authorization but we have no checkout in
      // flight (shouldn't normally happen). Decline rather than silently
      // approving.
      trace('No checkout in flight - declining defensively');
      sendResult('8A023035'); // tag 8A len 2, ASCII "05" = do not honour
      return;
    }

    setCardStatus('processing', 'Card detected. Authorizing with GxPay...');
    trace('Calling backend /api/payments/charge for GxPay authorization');

    submitCharge({
      entryMode: 'ICC',
      emvTags: emvRequestTlvHex,
      maskedPan: null, // not known yet for ICC at this point - GxPay/receipt fills it in from the chip data
    })
      .then((result) => {
        state.lastResult = result;
        const approved = result.receipt && result.receipt.status === 'approved';
        const tlv = buildOnlineAuthTlv(approved);
        trace(`GxPay responded: ${approved ? 'approved' : 'declined'}`, `sending ${tlv} back to terminal`);
        sendResult(tlv);
      })
      .catch((err) => {
        console.error('[PaymentProcessor] online authorization failed:', err);
        state.lastResult = { status: 'error', message: err.message };
        trace('Backend/GxPay call failed', err.message);
        sendResult('8A023035'); // fail safe: decline the chip transaction, never auto-approve on error
      });
  }

  /**
   * Swipe (MCR) / contactless-magstripe (NFC_ONLINE) transactions: the full
   * card read (already DUKPT/3DES-encrypted by the terminal's hardware) is
   * available directly from onDoTradeResult - there is no separate
   * online-process step for these entry modes in this SDK, so we submit the
   * charge here.
   *
   * `fields` is the raw msg1 array from onDoTradeResult:
   *  [track1, track2, track3, formatId, cardNum, expiredData, serviceCode,
   *   serviceCode1, pinBlock, trackksn, pinksn]
   * All of these except pinBlock/trackksn/pinksn/cardNum(masked) stay out of
   * both the DOM and the network payload - see maskPan()/buildDevicePayload().
   */
  function onCardRead(entryMode, fields) {
    if (!state.pending) return;

    setCardStatus('processing', 'Card detected. Sending to GxPay...');
    trace(`${entryMode} card read`, 'sending to GxPay');

    const cardNum = fields[4] || '';
    const track2 = (fields[1] || '').toUpperCase();
    const pinBlock = (fields[8] || '').toUpperCase();
    const trackksn = (fields[9] || '').toUpperCase();

    submitCharge({
      entryMode,
      maskedPan: maskPan(cardNum),
      encryptedTrack2: track2 || null,
      encryptedPinBlock: pinBlock || null,
      ksn: trackksn || null,
    })
      .then((result) => {
        state.lastResult = result;
        trace('GxPay responded', result.receipt ? result.receipt.status : result.status);
        renderReceiptFromResult(result);
      })
      .catch((err) => {
        console.error('[PaymentProcessor] charge failed:', err);
        setCardStatus('error', `Payment failed: ${err.message}`);
        trace('Charge failed', err.message);
        resetCheckoutButton();
      });
  }

  /**
   * Fires the moment a chip is first detected, well before EMV processing
   * or GxPay authorization even starts - despite the SDK naming this
   * "onDoTradeResult(ICC)", it is NOT the transaction's completion signal.
   * Confirmed via real-device trace logs: this fires ~7-15s before GxPay is
   * even called. Kept as a trace point only - state.lastResult is always
   * null here, so there is nothing to render yet. See onTransactionApproved()
   * for the real completion path.
   */
  function onTradeComplete(entryMode) {
    if (entryMode !== 'ICC') return;
    trace('Chip detected, entering EMV kernel', 'not the completion signal - see onTransactionApproved()');
  }

  /**
   * The terminal's own final confirmation that a chip transaction actually
   * completed (fires from onRequestTransactionResult('APPROVED') in
   * Script.js, after the card's cryptogram exchange finishes). GxPay's
   * result was already obtained and stored back in
   * onOnlineAuthorizationRequest - this just renders it now that the device
   * confirms the EMV exchange genuinely finished, rather than assuming it
   * was already shown (an earlier version of this code made that wrong
   * assumption and silently left the UI stuck on "Authorizing..." even
   * though the payment had actually succeeded).
   */
  function onTransactionApproved() {
    trace('Device confirms transaction complete', 'APPROVED');
    if (state.lastResult) {
      renderReceiptFromResult(state.lastResult);
    } else {
      // Shouldn't happen - the device confirmed approval but we have no
      // stored GxPay result to show. Surface it rather than staying silent.
      setCardStatus('error', 'Device confirmed approval, but no payment result was recorded.');
      trace('No stored result to render', 'check onOnlineAuthorizationRequest - this should not happen');
      resetCheckoutButton();
    }
  }

  function onDeviceError(kind, message) {
    trace(`Device event: ${kind}`, message);
    setCardStatus(kind, message);
    resetCheckoutButton();
  }

  // For neutral/informational device prompts (e.g. "please remove your
  // card") that aren't necessarily errors or declines - updates the
  // transaction feed without recoloring the status pill, since the same
  // prompt can appear after a perfectly normal approved transaction too.
  function onDeviceMessage(text) {
    trace('Device', text);
  }

  // ---- device reset (Device settings -> Reset device) --------------------
  // A deliberate, operator-triggered action - see the note in Script.js's
  // resetDevice() on why this is never run automatically before checkout.
  // Uses the status pill (not just the trace log) so the operator sees
  // this happened without needing to read the diagnostic feed.
  function onResetStarted() {
    trace('Resetting device', 'sending CMDID_RESET to clear stale session state');
    setCardStatus('processing', 'Resetting device...');
  }

  function onResetComplete() {
    trace('Device acknowledged reset');
    setCardStatus('approved', 'Device reset complete. You can try a new transaction now.');
  }

  // ---- networking to our own backend (never directly to GxPay) ------------
  function maskPan(cardNum) {
    if (!cardNum) return null;
    const digits = String(cardNum).replace(/\D/g, '');
    if (digits.length < 4) return '**** **** **** ****';
    return `${digits.slice(0, 6)}${'*'.repeat(Math.max(0, digits.length - 10))}${digits.slice(-4)}`;
  }

  function submitCharge(device) {
    const p = state.pending;
    const payload = {
      amount: p.amount,
      currency: p.currencyAlpha,
      reference: p.reference,
      device: Object.assign({ model: 'CR100-SCRP' }, device),
    };
    if (p.items && p.items.length) payload.items = p.items;

    return fetch('/api/payments/charge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (res.status >= 500) {
        throw new Error(body.message || 'Payment gateway error');
      }
      // 200 (approved) and 402 (declined) both resolve here - both are
      // "the gateway answered", just with a different outcome.
      return { httpStatus: res.status, receipt: body.receipt, status: body.status, errors: body.errors };
    });
  }

  // ---- receipt rendering / status confirm / print --------------------------
  function renderReceiptFromResult(result) {
    resetCheckoutButton();

    if (!result || result.status === 'error' || !result.receipt) {
      setCardStatus('error', (result && result.message) || 'Payment could not be completed.');
      trace('Payment not completed', (result && result.message) || 'unknown error');
      return;
    }

    const receipt = result.receipt;
    const approved = receipt.status === 'approved';
    setCardStatus(approved ? 'approved' : 'declined', approved ? 'Payment approved.' : `Payment declined: ${receipt.responseMessage || ''}`);
    trace(approved ? 'Payment approved' : 'Payment declined', receipt.responseMessage || '');

    // Clear the cart only on approval - the transaction is genuinely done,
    // ready for the next customer. On a decline, deliberately leave the
    // cart as-is so the operator can retry the exact same cart with a
    // different card without having to rebuild it from scratch.
    if (approved && global.Transactions && global.Transactions.clearCart) {
      global.Transactions.clearCart();
    }

    showReceipt(receipt);
  }

  function showReceipt(receipt) {
    const wrap = $('receipt-panel');
    const body = $('receipt-body');
    const badge = $('receipt-status-badge');
    const descriptionEl = $('receipt-description');
    if (!wrap || !body) return;

    const approved = receipt.status === 'approved';
    if (badge) {
      badge.textContent = approved ? 'Approved' : receipt.status.charAt(0).toUpperCase() + receipt.status.slice(1);
      badge.className = `gx-receipt-status ${approved ? 'approved' : receipt.status}`;
    }

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
      ['Amount', `${receipt.currency} ${receipt.amount}`],
      ['Card', `${receipt.cardScheme || ''} ${receipt.card}`.trim()],
      ['Entry Mode', receipt.entryMode],
      ['Auth Code', receipt.authCode || '-'],
      ['RRN', receipt.rrn || '-'],
      ['Gateway Ref', receipt.gatewayReference || '-'],
      ['Status', receipt.status.toUpperCase()],
      ['Message', receipt.responseMessage || '-'],
      ['Time', new Date(receipt.timestamp).toLocaleString()],
    ];

    body.innerHTML =
      rows
        .map(([label, value]) => `<div class="gx-receipt-row"><span class="label">${label}</span><span class="value">${escapeHtml(String(value))}</span></div>`)
        .join('') +
      (global.Transactions && global.Transactions.renderReceiptItemsHtml ? global.Transactions.renderReceiptItemsHtml(receipt) : '');

    wrap.classList.add('is-visible');
  }

  function hideReceipt() {
    const wrap = $('receipt-panel');
    if (wrap) wrap.classList.remove('is-visible');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function resetCheckoutButton() {
    const btn = $('checkout-btn');
    if (btn) btn.disabled = false;
  }

  function confirmStatus() {
    if (!state.pending || !state.pending.reference) return;
    trace('Confirming payment status with GxPay');
    fetch(`/api/payments/${encodeURIComponent(state.pending.reference)}/status`)
      .then((res) => res.json())
      .then((data) => {
        trace(`Status confirmed: ${data.status.toUpperCase()}`, `source: ${data.source || 'local'}`);
        if (data.receipt) showReceipt(data.receipt);
      })
      .catch((err) => {
        trace('Could not confirm status', err.message);
      });
  }

  function printReceipt() {
    window.print();
  }

  /**
   * Downloads the current receipt as a branded PDF (server-rendered - see
   * lib/receiptPdf.js). Uses a temporary off-screen link + programmatic
   * click, the standard technique for triggering a same-origin file
   * download without navigating the page away from the checkout screen.
   * The backend sets Content-Disposition: attachment, so the browser saves
   * it straight to the user's downloads location - no client-side PDF
   * library needed.
   */
  function downloadReceiptPdf() {
    if (!state.pending || !state.pending.reference) return;
    const btn = $('download-receipt-btn');
    const reference = state.pending.reference;
    trace('Downloading receipt PDF', reference);
    if (btn) btn.disabled = true;

    fetch(`/api/payments/${encodeURIComponent(reference)}/receipt.pdf`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message || `PDF download failed (HTTP ${res.status})`);
        }
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `gxpay-receipt-${reference}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        trace('Receipt PDF saved', `gxpay-receipt-${reference}.pdf`);
      })
      .catch((err) => {
        trace('Could not download receipt PDF', err.message);
      })
      .finally(() => {
        if (btn) btn.disabled = false;
      });
  }

  // ---- PIN entry modal ---------------------------------------------------
  // Replaces the original stock demo's window.prompt()-based dialog()
  // (public/dist/js/Script.js), which showed the PIN in plain, unmasked
  // text and pre-filled a hardcoded "123456" default that could be
  // submitted by accident. Fires from Script.js's onRequestSetPin()
  // whenever the terminal needs the host app to collect a PIN.
  let pendingPinCallback = null;

  /**
   * @param {(pin: string) => void} sendPinCallback - wraps
   *   mService.sendPin(...) (see Script.js). Called with the entered PIN,
   *   or an empty string if the operator cancels - sendPin("") is an
   *   explicitly SDK-supported "no PIN provided" signal (confirmed in
   *   main.js: it takes a distinct code path, not just an empty PIN sent
   *   as-is), so cancelling doesn't leave the terminal with no response.
   */
  function onPinRequested(sendPinCallback) {
    trace('Device requested PIN entry');
    pendingPinCallback = sendPinCallback;
    const input = $('pin-input');
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 50);
    }
    global.openModal('pinModal');
  }

  function submitPin() {
    const input = $('pin-input');
    const pin = input ? input.value.trim() : '';
    if (!pin) {
      if (input) input.focus();
      return;
    }
    // Never trace the actual PIN digits - length/masked only.
    trace('PIN entered', '*'.repeat(pin.length));
    global.closeModal('pinModal');
    const callback = pendingPinCallback;
    pendingPinCallback = null;
    if (callback) callback(pin);
  }

  function cancelPin() {
    trace('PIN entry cancelled by operator');
    global.closeModal('pinModal');
    const callback = pendingPinCallback;
    pendingPinCallback = null;
    if (callback) callback('');
  }

  function pinKeyPress(digit) {
    const input = $('pin-input');
    if (!input) return;
    if (input.value.length >= (input.getAttribute('maxlength') || 12)) return;
    input.value += digit;
    input.focus();
  }

  function pinKeyBackspace() {
    const input = $('pin-input');
    if (!input) return;
    input.value = input.value.slice(0, -1);
    input.focus();
  }

  function pinKeyClear() {
    const input = $('pin-input');
    if (!input) return;
    input.value = '';
    input.focus();
  }

  // ---- public API ------------------------------------------------------------
  global.PaymentProcessor = {
    onWaitingForCard,
    onOnlineAuthorizationRequest,
    onCardRead,
    onTradeComplete,
    onTransactionApproved,
    onDeviceError,
    onDeviceMessage,
    confirmStatus,
    printReceipt,
    downloadReceiptPdf,
    onPinRequested,
    submitPin,
    cancelPin,
    pinKeyPress,
    pinKeyBackspace,
    pinKeyClear,
    onResetStarted,
    onResetComplete,
    trace, // exposed so Script.js can log raw device/protocol events too
  };
  global.checkout = checkout;
})(window);
