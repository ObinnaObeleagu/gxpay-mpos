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
 * Script.js calls into this module at four points (see the edits in
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

  function setResultText(text) {
    const el = $('result_div');
    if (el) el.innerText = text;
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
    };

    setResultText('Starting transaction...');
    setCardStatus('waiting', 'Preparing card reader...');
    if (checkoutBtn) checkoutBtn.disabled = true;

    // Reset the device's session state before every new charge. A stale
    // session left over from a previous attempt (card removed mid-trade,
    // a dropped Bluetooth packet, a prior charge that didn't complete
    // cleanly, etc.) is the most common real-world cause of the reader
    // firmware aborting the next command with CMDID_DESTRUCT
    // ("DEVICE_ERROR" - see onRequestTransactionResult in Script.js). This
    // is fire-and-forget at the SDK level (no callback), so we just give it
    // a brief moment to land before issuing the trade.
    if (typeof mService !== 'undefined' && mService.resetPosStatus) {
      try {
        mService.resetPosStatus();
      } catch (e) {
        console.warn('[PaymentProcessor] resetPosStatus failed (continuing anyway):', e);
      }
    }

    setTimeout(() => {
      // Delegates to the existing Dspread SDK wiring in Script.js, which
      // calls mService.setAmount(...) and mService.doTrade(...). Card
      // presentment (insert/swipe/tap) then drives the
      // onRequestWaitingUser / onRequestOnlineProcess / onDoTradeResult
      // callbacks this module hooks. Pass the raw typed string (not the
      // reformatted float) to the device SDK, matching what
      // setAmount()/doTrade() expect.
      global.startTrade(amountInput.value, currency.numeric, transactionTypeSelect ? transactionTypeSelect.value : '10');
    }, 200);
  }

  // ---- callbacks invoked from Script.js's QPOSServiceListenerImpl ---------

  function onWaitingForCard() {
    setCardStatus('waiting', 'Please insert, swipe, or tap your card now.');
    setResultText('Waiting for card...');
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
   *
   * IMPORTANT: this now includes tag 91 (ARPC) whenever the gateway returns
   * one, not just tag 8A (response code) - sending only tag 8A was found to
   * cause some terminal/EMV-kernel configurations to hard-abort the session
   * (CMDID_DESTRUCT / "DEVICE_ERROR") right at this handoff point instead of
   * completing normally. Issuer scripts (tags 71/72) are NOT relayed here -
   * confirm with GxPay/Dspread whether your specific setup ever needs them
   * before going live - see README-PAYMENT-INTEGRATION.md.
   */
  /**
   * Builds the WriteBackIc()-style reply the Dspread EMV kernel expects for
   * an online-authorized chip transaction: tag 8A (Authorization Response
   * Code) is always present, and tag 91 (Issuer Authentication Data / ARPC)
   * should be included whenever the gateway/issuer returned one - many EMV
   * kernel configurations require it to complete the card's second
   * GENERATE AC exchange, and sending only tag 8A appears to be exactly
   * what causes some terminals to hard-abort the session (CMDID_DESTRUCT /
   * "DEVICE_ERROR") instead of completing normally. Declines don't carry an
   * ARPC (the card never needs to authenticate the issuer for a decline).
   * CONFIRM: GxPay's actual field name for the ARPC in its response, and
   * whether it also returns issuer script data (tags 71/72) that should be
   * appended here for specific transactions - see gxpayClient.js.
   */
  function buildOnlineAuthTlv(approved, arpcHex) {
    const responseCode = approved ? '8A023030' : '8A023035';
    if (!approved || !arpcHex) return responseCode;
    const clean = arpcHex.replace(/[^0-9a-fA-F]/g, '');
    const lenByte = (clean.length / 2).toString(16).padStart(2, '0');
    return `${responseCode}91${lenByte}${clean}`;
  }

  function onOnlineAuthorizationRequest(emvRequestTlvHex, sendResult) {
    if (!state.pending) {
      // Defensive: device asked for authorization but we have no checkout in
      // flight (shouldn't normally happen). Decline rather than silently
      // approving.
      sendResult('8A023035'); // tag 8A len 2, ASCII "05" = do not honour
      return;
    }

    setCardStatus('processing', 'Card detected. Authorizing with GxPay...');
    setResultText('Chip card read. Sending to GxPay for authorization...');

    submitCharge({
      entryMode: 'ICC',
      emvTags: emvRequestTlvHex,
      maskedPan: null, // not known yet for ICC at this point - GxPay/receipt fills it in from the chip data
    })
      .then((result) => {
        state.lastResult = result;
        const approved = result.receipt && result.receipt.status === 'approved';
        const arpc = result.receipt && result.receipt.arpc;
        sendResult(buildOnlineAuthTlv(approved, arpc));
      })
      .catch((err) => {
        console.error('[PaymentProcessor] online authorization failed:', err);
        state.lastResult = { status: 'error', message: err.message };
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
    setResultText(`${entryMode === 'NFC_ONLINE' ? 'Contactless' : 'Swipe'} card read. Processing payment...`);

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
        renderReceiptFromResult(result);
      })
      .catch((err) => {
        console.error('[PaymentProcessor] charge failed:', err);
        setCardStatus('error', `Payment failed: ${err.message}`);
        setResultText(`Payment failed: ${err.message}`);
        resetCheckoutButton();
      });
  }

  /**
   * ICC transactions finish here (after onOnlineAuthorizationRequest already
   * ran and the chip completed its cryptogram exchange). We already have the
   * GxPay result from that step - just render it now that the device
   * confirms the transaction is done.
   */
  function onTradeComplete(entryMode) {
    if (entryMode !== 'ICC') return;
    if (state.lastResult) {
      renderReceiptFromResult(state.lastResult);
    }
  }

  function onDeviceError(kind, message) {
    setCardStatus(kind, message);
    setResultText(message);
    resetCheckoutButton();
  }

  // For neutral/informational device prompts (e.g. "please remove your
  // card") that aren't necessarily errors or declines - updates the
  // transaction feed without recoloring the status pill, since the same
  // prompt can appear after a perfectly normal approved transaction too.
  function onDeviceMessage(text) {
    setResultText(text);
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
      setResultText((result && result.message) || 'Payment could not be completed.');
      return;
    }

    const receipt = result.receipt;
    const approved = receipt.status === 'approved';
    setCardStatus(approved ? 'approved' : 'declined', approved ? 'Payment approved.' : `Payment declined: ${receipt.responseMessage || ''}`);
    setResultText(approved ? 'Payment approved. Receipt below.' : `Payment declined. ${receipt.responseMessage || ''}`);

    showReceipt(receipt);
  }

  function showReceipt(receipt) {
    const wrap = $('receipt-panel');
    const body = $('receipt-body');
    const badge = $('receipt-status-badge');
    if (!wrap || !body) return;

    const approved = receipt.status === 'approved';
    if (badge) {
      badge.textContent = approved ? 'Approved' : receipt.status.charAt(0).toUpperCase() + receipt.status.slice(1);
      badge.className = `gx-receipt-status ${approved ? 'approved' : receipt.status}`;
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

    body.innerHTML = rows
      .map(([label, value]) => `<div class="gx-receipt-row"><span class="label">${label}</span><span class="value">${escapeHtml(String(value))}</span></div>`)
      .join('');

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
    setResultText('Confirming payment status with GxPay...');
    fetch(`/api/payments/${encodeURIComponent(state.pending.reference)}/status`)
      .then((res) => res.json())
      .then((data) => {
        setResultText(`Status confirmed: ${data.status.toUpperCase()} (source: ${data.source || 'local'})`);
        if (data.receipt) showReceipt(data.receipt);
      })
      .catch((err) => {
        setResultText(`Could not confirm status: ${err.message}`);
      });
  }

  function printReceipt() {
    window.print();
  }

  // ---- public API ------------------------------------------------------------
  global.PaymentProcessor = {
    onWaitingForCard,
    onOnlineAuthorizationRequest,
    onCardRead,
    onTradeComplete,
    onDeviceError,
    onDeviceMessage,
    confirmStatus,
    printReceipt,
  };
  global.checkout = checkout;
})(window);
