'use strict';

const crypto = require('crypto');
const config = require('../config/env');

/**
 * ---------------------------------------------------------------------------
 * GxPay gateway client
 * ---------------------------------------------------------------------------
 * This module is the ONLY place that talks to GxPay. Everything else in the
 * app (routes/payments.js) works against the normalized shape returned by
 * chargeCard() / queryStatus() below, so if GxPay's actual field names differ
 * from what's assumed here, you only need to edit two functions:
 *
 *    buildChargePayload()   - maps our internal charge request -> GxPay's body
 *    normalizeGxPayResponse() - maps GxPay's response -> our internal shape
 *
 * IMPORTANT: I was not able to pull GxPay's authenticated API reference
 * (https://merchant-api-dev.gxpay.net/api/v1/docs and the GxPay Postman
 * workspace both require a merchant login), so the endpoint path, auth
 * scheme and field names below are a best-effort based on common
 * card-present gateway conventions (Bearer key/secret, JSON body, amount in
 * minor units). Everything that's an assumption is tagged "CONFIRM:" so you
 * can grep for it and cross-check against your GxPay merchant dashboard /
 * dev docs / Postman collection before going live.
 *
 * Until you've confirmed those details, run with GXPAY_MODE=mock (the
 * default) - it exercises the full charge -> receipt -> status-confirm
 * pipeline without calling out to GxPay at all, which is what the automated
 * smoke test (scripts/smoke-test.js) and local UI testing use.
 * ---------------------------------------------------------------------------
 */

class GxPayError extends Error {
  constructor(message, { statusCode, responseCode, responseBody } = {}) {
    super(message);
    this.name = 'GxPayError';
    this.statusCode = statusCode;
    this.responseCode = responseCode;
    this.responseBody = responseBody;
  }
}

function assertLiveConfigPresent() {
  const missing = [];
  if (!config.gxpay.apiKey) missing.push('GXPAY_API_KEY');
  if (!config.gxpay.merchantId) missing.push('GXPAY_MERCHANT_ID');
  if (config.gxpay.signing === 'hmac' && !config.gxpay.apiSecret) missing.push('GXPAY_API_SECRET');
  if (missing.length) {
    throw new GxPayError(
      `GxPay is set to mode="${config.gxpay.mode}" but missing required env var(s): ${missing.join(', ')}`
    );
  }
}

function signBody(rawBody) {
  // CONFIRM: swap for GxPay's actual signing recipe once confirmed (some
  // gateways sign amount+reference+timestamp instead of the raw body).
  return crypto.createHmac('sha256', config.gxpay.apiSecret).update(rawBody).digest('hex');
}

function buildHeaders(rawBody) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.gxpay.apiKey}`,
    'X-Merchant-Id': config.gxpay.merchantId,
    'X-Terminal-Id': config.gxpay.terminalId || config.terminalId,
  };
  if (config.gxpay.signing === 'hmac') {
    headers['X-GxPay-Signature'] = signBody(rawBody);
  }
  return headers;
}

/**
 * Maps our internal charge request into GxPay's expected request body.
 * CONFIRM: endpoint path is assumed to be POST {baseUrl}/v1/transactions/sale
 * and field names below - adjust to match the real GxPay API contract.
 */
function buildChargePayload(request) {
  const { amountMinorUnits, currency, reference, device, merchant } = request;
  return {
    merchant_id: merchant.merchantId,
    terminal_id: merchant.terminalId,
    reference,
    amount: amountMinorUnits, // CONFIRM: minor units (e.g. kobo/cents) vs major units
    currency, // CONFIRM: ISO-4217 alpha code vs GxPay's own numeric code
    channel: 'CARD_PRESENT',
    entry_mode: device.entryMode, // ICC | MCR | NFC_ONLINE
    card: {
      masked_pan: device.maskedPan,
      expiry: device.expiry || null, // only ever masked/blank - see security notes in README
      ksn: device.ksn || null,
      encrypted_track2: device.encryptedTrack2 || null,
      encrypted_pin_block: device.encryptedPinBlock || null,
      emv_tags: device.emvTags || null,
    },
    device: {
      model: device.model || 'CR100-SCRP',
      serial: device.serial || null,
    },
  };
}

/**
 * Maps GxPay's response into the normalized shape the rest of the app uses.
 * CONFIRM: field names on the response body.
 */
function normalizeGxPayResponse(body) {
  const approved = body.status === 'approved' || body.response_code === '00';
  return {
    status: approved ? 'approved' : 'declined',
    gatewayReference: body.transaction_id || body.reference || null,
    authCode: body.auth_code || null,
    rrn: body.rrn || null,
    responseCode: body.response_code || null,
    responseMessage: body.response_message || body.message || (approved ? 'Approved' : 'Declined'),
    cardScheme: body.card_scheme || null,
    maskedPan: body.masked_pan || null,
    raw: body,
  };
}

async function postJson(path, payload) {
  const rawBody = JSON.stringify(payload);
  const url = `${config.gxpay.baseUrl.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.gxpay.timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(rawBody),
      body: rawBody,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new GxPayError('GxPay request timed out');
    }
    throw new GxPayError(`GxPay request failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  let body;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    throw new GxPayError(body.message || `GxPay returned HTTP ${res.status}`, {
      statusCode: res.status,
      responseCode: body.response_code,
      responseBody: body,
    });
  }
  return body;
}

// ---------------------------------------------------------------------------
// Mock mode - simulates a realistic GxPay round trip with no network calls.
// Lets the full UI flow (card read -> checkout -> receipt -> status confirm)
// be tested end-to-end before real GxPay sandbox credentials are available.
// ---------------------------------------------------------------------------
function mockCharge(request) {
  const { amountMinorUnits, currency, reference, device } = request;
  // Deterministic "decline" for a magic test amount so the UI's declined
  // path can be exercised too: any amount ending in .13 (i.e. cents == 13)
  // declines, e.g. 5.13, 100.13.
  const declines = Math.round(amountMinorUnits) % 100 === 13;

  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        status: declines ? 'declined' : 'approved',
        transaction_id: `MOCK-${crypto.randomUUID()}`,
        reference,
        auth_code: declines ? null : crypto.randomInt(100000, 999999).toString(),
        rrn: crypto.randomInt(100000000000, 999999999999).toString(),
        response_code: declines ? '05' : '00',
        response_message: declines ? 'Do not honour (mock decline test amount)' : 'Approved (mock)',
        card_scheme: device.cardScheme || 'VISA',
        masked_pan: device.maskedPan,
        amount: amountMinorUnits,
        currency,
      });
    }, 600 + Math.random() * 500); // simulate realistic network/gateway latency
  });
}

/**
 * Charge a card using the encrypted payload captured from the CR100-SCRP.
 * @param {object} request see buildChargePayload() for shape
 */
async function chargeCard(request) {
  if (config.gxpay.mode === 'mock') {
    const body = await mockCharge(request);
    return normalizeGxPayResponse(body);
  }

  assertLiveConfigPresent();
  const payload = buildChargePayload(request);
  const body = await postJson('/v1/transactions/sale', payload); // CONFIRM: endpoint path
  return normalizeGxPayResponse(body);
}

/**
 * Query GxPay directly for the current status of a previously-submitted
 * transaction (used by GET /api/payments/:reference/status as a fallback
 * when we don't already have a fresher status from our own store/webhook).
 */
async function queryStatus(reference) {
  if (config.gxpay.mode === 'mock') {
    return null; // caller falls back to the locally stored result
  }
  assertLiveConfigPresent();
  const body = await postJson('/v1/transactions/status', { reference }); // CONFIRM: endpoint path
  return normalizeGxPayResponse(body);
}

module.exports = {
  GxPayError,
  chargeCard,
  queryStatus,
  // exported for unit testing / smoke test reuse
  buildChargePayload,
  normalizeGxPayResponse,
};
