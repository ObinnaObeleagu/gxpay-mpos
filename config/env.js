'use strict';

require('dotenv').config();

/**
 * Central place for all environment-driven configuration.
 * Nothing else in the codebase should call process.env directly -
 * that keeps every config knob documented in one spot (and in .env.example).
 */
const toBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const config = {
  // --- Server ---
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  allowedOrigin: process.env.ALLOWED_ORIGIN || '*',

  // --- Merchant / terminal identity ---
  merchantName: process.env.MERCHANT_NAME || 'Demo Merchant',
  merchantId: process.env.GXPAY_MERCHANT_ID || '',
  terminalId: process.env.GXPAY_TERMINAL_ID || 'CR100-SCRP-001',

  // --- GxPay gateway ---
  gxpay: {
    // 'mock' lets you run the full checkout -> charge -> receipt -> confirm
    // flow with no live credentials (good for local/dev/CI testing).
    // 'sandbox' / 'live' hit the real GxPay API using the values below.
    mode: (process.env.GXPAY_MODE || 'mock').toLowerCase(),
    baseUrl: process.env.GXPAY_BASE_URL || 'https://api.gxpay.net',
    apiKey: process.env.GXPAY_API_KEY || '',
    apiSecret: process.env.GXPAY_API_SECRET || '',
    merchantId: process.env.GXPAY_MERCHANT_ID || '',
    terminalId: process.env.GXPAY_TERMINAL_ID || '',
    // 'bearer'  -> Authorization: Bearer <apiKey>
    // 'hmac'    -> Authorization: Bearer <apiKey> + X-GxPay-Signature: HMAC-SHA256(body, apiSecret)
    signing: (process.env.GXPAY_SIGNING || 'bearer').toLowerCase(),
    timeoutMs: parseInt(process.env.GXPAY_TIMEOUT_MS, 10) || 20000,
    webhookSecret: process.env.GXPAY_WEBHOOK_SECRET || '',
  },

  security: {
    // In mock mode we allow raw device payload logging to help debugging;
    // never do this against a live gateway with real cardholder data.
    verboseCardLogging: toBool(process.env.VERBOSE_CARD_LOGGING, false),
  },
};

module.exports = config;
