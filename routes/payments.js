'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('../config/env');
const gxpay = require('../services/gxpayClient');
const store = require('../store/transactionStore');
const { validateDevicePayload, maskAmountReceiptCard } = require('../lib/cardPayload');
const { renderReceiptPdf } = require('../lib/receiptPdf');

const router = express.Router();

function toMinorUnits(amount) {
  const n = Number(amount);
  return Math.round(n * 100);
}

/**
 * Validates an optional cart line-items array - see the "items" field on
 * POST /charge below. Each line needs a name, a non-negative unit price,
 * and a positive integer quantity.
 */
function validateItems(items) {
  const errors = [];
  if (items === undefined) return errors;
  if (!Array.isArray(items) || items.length === 0) {
    errors.push('items must be a non-empty array if provided');
    return errors;
  }
  items.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      errors.push(`items[${i}] must be an object`);
      return;
    }
    if (!item.name || typeof item.name !== 'string') {
      errors.push(`items[${i}].name is required`);
    }
    if (item.unitPrice === undefined || Number.isNaN(Number(item.unitPrice)) || Number(item.unitPrice) < 0) {
      errors.push(`items[${i}].unitPrice must be a non-negative number`);
    }
    if (item.qty === undefined || !Number.isInteger(Number(item.qty)) || Number(item.qty) < 1) {
      errors.push(`items[${i}].qty must be a positive integer`);
    }
  });
  return errors;
}

/** Sum of unitPrice * qty across all cart lines - the authoritative charge
 *  amount whenever items are present (see the note in POST /charge on why
 *  this is computed server-side rather than trusting a client-supplied
 *  amount when we have the line items to derive it from directly). */
function totalForItems(items) {
  return items.reduce((sum, item) => sum + Number(item.unitPrice) * Number(item.qty), 0);
}

function summarizeItems(items) {
  if (!items || !items.length) return null;
  if (items.length === 1) {
    const item = items[0];
    return item.qty > 1 ? `${item.qty} x ${item.name}` : item.name;
  }
  return `${items.length} items`;
}

function buildReceipt({ reference, amount, currency, result, device, description, items }) {
  const normalizedItems = items
    ? items.map((item) => ({
        name: item.name,
        unitPrice: Number(item.unitPrice).toFixed(2),
        qty: Number(item.qty),
        lineTotal: (Number(item.unitPrice) * Number(item.qty)).toFixed(2),
      }))
    : null;

  return {
    reference,
    merchant: config.merchantName,
    terminalId: config.terminalId,
    amount: Number(amount).toFixed(2),
    currency,
    // What was actually sold, e.g. "Sale of wine" / "Payment for swimming
    // service" / "3 items" for a multi-item cart. Set from a selected
    // catalog item or cart (see store/catalogStore.js, the Checkout tab's
    // cart), typed manually, or auto-derived from items[] below when not
    // given explicitly. Optional - a bare custom-amount charge has none.
    description: description || summarizeItems(items) || null,
    // Itemized cart lines, when the charge was for more than a single bare
    // amount - each with its own unit price/qty/line total so the receipt
    // can show a real itemized breakdown, not just a summary line. Null
    // for a plain custom-amount or single-description charge.
    items: normalizedItems,
    card: maskAmountReceiptCard(result.maskedPan || device.maskedPan),
    cardScheme: result.cardScheme || device.cardScheme || null,
    entryMode: device.entryMode,
    status: result.status,
    authCode: result.authCode,
    rrn: result.rrn,
    gatewayReference: result.gatewayReference,
    responseMessage: result.responseMessage,
    timestamp: new Date().toISOString(),
  };
}

/**
 * GET /api/payments
 * Lists stored transactions, most recent first - powers the Transactions
 * tab. Query params: status (approved|declined|pending|error) to filter,
 * limit (default 100, max 500). Returns summaries only (not full receipts)
 * to keep the payload light - the UI fetches full receipt detail per
 * transaction via GET /:reference/status when the user views/reprints one.
 */
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const records = (await store.list({ status })).slice(0, limit);

    const transactions = records.map((r) => ({
      reference: r.reference,
      status: r.status,
      amount: r.amount,
      currency: r.currency,
      description: r.description || (r.receipt && r.receipt.description) || null,
      entryMode: (r.device && r.device.entryMode) || (r.receipt && r.receipt.entryMode) || null,
      card: (r.receipt && r.receipt.card) || (r.device && r.device.maskedPan) || null,
      cardScheme: (r.receipt && r.receipt.cardScheme) || null,
      authCode: (r.receipt && r.receipt.authCode) || null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      hasReceipt: !!r.receipt,
    }));

    return res.json({ status: 'ok', count: transactions.length, transactions });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[payments/list] failed:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to list transactions' });
  }
});

/**
 * POST /api/payments/charge
 * Body: { amount, currency, reference?, description?, device: { entryMode,
 *         maskedPan, ksn, encryptedTrack2?, encryptedPinBlock?, emvTags?,
 *         model, serial } }
 * `description` is optional free text (e.g. "Sale of wine") - typically set
 * from a selected catalog item, see store/catalogStore.js and
 * routes/catalog.js.
 */
router.post('/charge', async (req, res) => {
  const { currency, device, description, items } = req.body || {};
  let { amount } = req.body || {};
  const reference = req.body?.reference || `TXN-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  // --- validation ---
  const errors = [];
  errors.push(...validateItems(items));

  // When a cart (items[]) is provided, the charge amount is always
  // computed from it server-side, never trusted from the client - even
  // though the Checkout tab's cart total should already match, deriving
  // the authoritative amount from the line items directly (rather than a
  // separately-sent `amount` that could in principle drift from them,
  // whether from a bug or tampering) is the safer design.
  if (items !== undefined) {
    // items was provided (even if it turns out invalid) - don't also
    // complain about a separately missing `amount` below, that's not what
    // the client was attempting and would just be a confusing, redundant
    // second error message alongside the real one.
    if (errors.length === 0) {
      amount = totalForItems(items).toFixed(2);
    }
  } else if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    errors.push('amount must be a positive number');
  }
  if (!currency || typeof currency !== 'string') {
    errors.push('currency is required (e.g. "NGN", "USD")');
  }
  if (description !== undefined && typeof description !== 'string') {
    errors.push('description must be a string if provided');
  }
  errors.push(...validateDevicePayload(device));

  if (errors.length) {
    return res.status(400).json({ status: 'error', errors });
  }

  try {
    await store.save({
      reference,
      amount: Number(amount).toFixed(2),
      currency,
      description: description || summarizeItems(items) || null,
      status: 'pending',
      device: { entryMode: device.entryMode, model: device.model, maskedPan: device.maskedPan },
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[payments/charge] failed to record pending transaction:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to start transaction' });
  }

  try {
    const result = await gxpay.chargeCard({
      amountMinorUnits: toMinorUnits(amount),
      currency,
      reference,
      device,
      merchant: { merchantId: config.gxpay.merchantId, terminalId: config.gxpay.terminalId || config.terminalId },
    });

    const receipt = buildReceipt({ reference, amount, currency, result, device, description, items });

    await store.update(reference, {
      status: result.status,
      gatewayReference: result.gatewayReference,
      description: receipt.description,
      receipt,
    });

    const httpStatus = result.status === 'approved' ? 200 : 402;
    return res.status(httpStatus).json({ status: result.status, receipt });
  } catch (err) {
    const isGxPayError = err instanceof gxpay.GxPayError;
    // eslint-disable-next-line no-console
    console.error('[payments/charge] gateway error:', err.message);

    try {
      await store.update(reference, { status: 'error', error: err.message });
    } catch (storeErr) {
      // eslint-disable-next-line no-console
      console.error('[payments/charge] additionally failed to record the error:', storeErr.message);
    }

    return res.status(isGxPayError && err.statusCode ? 502 : 500).json({
      status: 'error',
      reference,
      message: err.message || 'Payment processing failed',
    });
  }
});

/**
 * GET /api/payments/:reference/status
 * Confirms the current status of a transaction - checks our own store first
 * (fastest, and reflects anything a GxPay webhook already updated), then
 * falls back to asking GxPay directly.
 */
router.get('/:reference/status', async (req, res) => {
  const { reference } = req.params;
  let local;
  try {
    local = await store.get(reference);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[payments/status] store lookup failed:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to look up transaction' });
  }

  if (local && local.status !== 'pending') {
    return res.json({ status: local.status, reference, receipt: local.receipt || null, source: 'local' });
  }

  try {
    const remote = await gxpay.queryStatus(reference);
    if (remote) {
      await store.update(reference, { status: remote.status });
      return res.json({ status: remote.status, reference, source: 'gxpay' });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[payments/status] gateway error:', err.message);
  }

  if (!local) {
    return res.status(404).json({ status: 'error', message: 'Unknown reference' });
  }
  return res.json({ status: local.status, reference, receipt: local.receipt || null, source: 'local' });
});

/**
 * GET /api/payments/:reference/receipt.pdf
 * Generates and downloads a branded PDF of a completed transaction's
 * receipt. Only serves transactions that actually have a stored receipt
 * (i.e. the charge attempt got at least as far as a gateway response) -
 * still-pending or unknown references get a plain error, not a PDF.
 */
router.get('/:reference/receipt.pdf', async (req, res) => {
  const { reference } = req.params;
  let record;
  try {
    record = await store.get(reference);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[payments/receipt.pdf] store lookup failed:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to look up transaction' });
  }

  if (!record || !record.receipt) {
    return res.status(404).json({ status: 'error', message: 'No receipt available for this reference' });
  }

  try {
    const pdfBuffer = await renderReceiptPdf(record.receipt);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="gxpay-receipt-${reference}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.send(pdfBuffer);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[payments/receipt.pdf] generation failed:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to generate receipt PDF' });
  }
});

/**
 * POST /api/payments/webhook/gxpay
 * Optional: receives asynchronous confirmation from GxPay if their platform
 * pushes status updates server-to-server rather than responding
 * synchronously to /v1/transactions/sale. CONFIRM the payload shape and
 * signature header name against GxPay's webhook docs before relying on this
 * in production - verifyWebhookSignature() is a placeholder HMAC check.
 */
router.post('/webhook/gxpay', express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }), async (req, res) => {
  if (config.gxpay.webhookSecret) {
    const signature = req.header('X-GxPay-Signature');
    const expected = crypto
      .createHmac('sha256', config.gxpay.webhookSecret)
      .update(req.rawBody || Buffer.from(JSON.stringify(req.body)))
      .digest('hex');
    if (!signature || signature !== expected) {
      return res.status(401).json({ status: 'error', message: 'Invalid webhook signature' });
    }
  }

  const { reference, status } = req.body || {};
  if (!reference || !status) {
    return res.status(400).json({ status: 'error', message: 'reference and status are required' });
  }

  try {
    const updated = await store.update(reference, { status });
    if (!updated) {
      return res.status(404).json({ status: 'error', message: 'Unknown reference' });
    }
    return res.json({ status: 'ok' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[payments/webhook] store update failed:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to record webhook update' });
  }
});

module.exports = router;
