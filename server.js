'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const config = require('./config/env');
const paymentsRouter = require('./routes/payments');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // required on Render (behind their proxy) for correct client IPs / rate limiting

app.use(
  helmet({
    // The checkout UI loads Google Fonts / Ionicons from a CDN and uses
    // inline event handler attributes (onclick="..."), so CSP is relaxed
    // rather than fully locked down. Tighten this once you migrate the
    // remaining inline onclick handlers to addEventListener.
    contentSecurityPolicy: false,
  })
);
app.use(cors({ origin: config.allowedOrigin }));
app.use(express.json({ limit: '256kb' }));
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));

// Payment endpoints get their own, tighter rate limit - this is the
// highest-value endpoint to protect against abuse/brute forcing.
const paymentsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/payments', paymentsLimiter, paymentsRouter);

app.get('/healthz', (_req, res) => res.json({ status: 'ok', gxpayMode: config.gxpay.mode }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'checkout.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error('[unhandled]', err);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Dspread CR100-SCRP web checkout listening on port ${config.port} (GxPay mode: ${config.gxpay.mode})`);
});

module.exports = app;
