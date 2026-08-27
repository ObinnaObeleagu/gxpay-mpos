'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('../config/env');
const gxpay = require('../services/gxpayClient');
const store = require('../store/transactionStore');
const { validateDevicePayload, maskAmountReceiptCard } = require('../lib/cardPayload');

const router = express.Router();

function toMinorUnits(amount) {
  const n = Number(amount);
  return Math.round(n * 100);
}

function buildReceipt({ reference, amount, currency, result, device }) {
  return {
    reference,
    merchant: config.merchantName,
    terminalId: config.terminalId,
    amount: Number(amount).toFixed(2),
    currency,
    card: maskAmountReceiptCard(result.maskedPan || device.maskedPan),
    cardScheme: result.cardScheme || device.cardScheme || null,
    entryMode: device.entryMode,
    status: result.status,
    authCode: result.authCode,
    rrn: result.rrn,
    gatewayReference: result.gatewayReference,
    responseMessage: result.responseMessage,
    // Only relevant for ICC (chip) - needed client-side to complete the EMV
    // online-authorization reply back to the terminal. Never displayed.
    arpc: result.arpc || null,
    timestamp: new Date().toISOString(),
  };
}

/**
 * POST /api/payments/charge
 * Body: { amount, currency, reference?, device: { entryMode, maskedPan, ksn,
 *         encryptedTrack2?, encryptedPinBlock?, emvTags?, model, serial } }
 */
router.post('/charge', async (req, res) => {
  const { amount, currency, device } = req.body || {};
  const reference = req.body?.reference || `TXN-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  // --- validation ---
  const errors = [];
  if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    errors.push('amount must be a positive number');
  }
  if (!currency || typeof currency !== 'string') {
    errors.push('currency is required (e.g. "NGN", "USD")');
  }
  errors.push(...validateDevicePayload(device));

  if (errors.length) {
    return res.status(400).json({ status: 'error', errors });
  }

  store.save({
    reference,
    amount: Number(amount).toFixed(2),
    currency,
    status: 'pending',
    device: { entryMode: device.entryMode, model: device.model, maskedPan: device.maskedPan },
    createdAt: new Date().toISOString(),
  });

  try {
    const result = await gxpay.chargeCard({
      amountMinorUnits: toMinorUnits(amount),
      currency,
      reference,
      device,
      merchant: { merchantId: config.gxpay.merchantId, terminalId: config.gxpay.terminalId || config.terminalId },
    });

    const receipt = buildReceipt({ reference, amount, currency, result, device });

    store.update(reference, {
      status: result.status,
      gatewayReference: result.gatewayReference,
      receipt,
    });

    const httpStatus = result.status === 'approved' ? 200 : 402;
    return res.status(httpStatus).json({ status: result.status, receipt });
  } catch (err) {
    const isGxPayError = err instanceof gxpay.GxPayError;
    // eslint-disable-next-line no-console
    console.error('[payments/charge] gateway error:', err.message);

    store.update(reference, { status: 'error', error: err.message });

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
  const local = store.get(reference);

  if (local && local.status !== 'pending') {
    return res.json({ status: local.status, reference, receipt: local.receipt || null, source: 'local' });
  }

  try {
    const remote = await gxpay.queryStatus(reference);
    if (remote) {
      store.update(reference, { status: remote.status });
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
 * POST /api/payments/webhook/gxpay
 * Optional: receives asynchronous confirmation from GxPay if their platform
 * pushes status updates server-to-server rather than responding
 * synchronously to /v1/transactions/sale. CONFIRM the payload shape and
 * signature header name against GxPay's webhook docs before relying on this
 * in production - verifyWebhookSignature() is a placeholder HMAC check.
 */
router.post('/webhook/gxpay', express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }), (req, res) => {
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

  const updated = store.update(reference, { status });
  if (!updated) {
    return res.status(404).json({ status: 'error', message: 'Unknown reference' });
  }
  return res.json({ status: 'ok' });
});

module.exports = router;
