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

  // --- Database (Supabase) ---
  // Both the transaction store and the catalog (items/services price list)
  // use this - see store/transactionStore.js, store/catalogStore.js. The
  // backend is auto-detected: if both SUPABASE_URL and
  // SUPABASE_SERVICE_ROLE_KEY are set, Supabase is used; otherwise the app
  // falls back to a zero-setup in-memory store (gone on restart - fine for
  // local dev/testing, not for production). There is no separate on/off
  // flag to keep out of sync with the credentials themselves.
  //
  // IMPORTANT: this must be the SERVICE ROLE key, not the anon/public key -
  // it grants full table access bypassing Row Level Security, so it must
  // only ever live server-side (here), exactly like the GxPay API
  // credentials above. Never expose it to the browser.
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },
};

config.supabase.isConfigured = Boolean(config.supabase.url && config.supabase.serviceKey);

module.exports = config;
