'use strict';

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Preflight check - runs BEFORE any of our own modules are require()'d.
// A "Cannot find module './config/env'" (or similar) crash means one of the
// app's own folders didn't make it into whatever Render actually deployed -
// this print outs exactly what's missing and what IS present, so you don't
// have to guess from a bare MODULE_NOT_FOUND stack trace. See
// README-PAYMENT-INTEGRATION.md, "Troubleshooting Render deploys".
// ---------------------------------------------------------------------------
const REQUIRED_PATHS = [
  'config/env.js',
  'routes/payments.js',
  'services/gxpayClient.js',
  'store/transactionStore.js',
  'lib/cardPayload.js',
  'public/checkout.html',
];

const missing = REQUIRED_PATHS.filter((rel) => !fs.existsSync(path.join(__dirname, rel)));

if (missing.length) {
  const present = fs.readdirSync(__dirname).sort();
  // eslint-disable-next-line no-console
  console.error(
    [
      '',
      'FATAL: this deploy is missing required application files:',
      ...missing.map((m) => `  - ${m}`),
      '',
      `Working directory (__dirname): ${__dirname}`,
      `Top-level contents actually present: ${present.join(', ')}`,
      '',
      'This means those folders/files did not make it into what Render deployed -',
      'it is not a bug in the code itself. Most likely cause: they were never',
      'committed/pushed to the git repo/branch Render is building from.',
      '',
      'To fix:',
      '  1. On your machine, in the project root, run: git status',
      '     Anything listed as "Untracked" for the folders above needs `git add`.',
      '  2. git add config routes services store lib public server.js package.json',
      '  3. git commit -m "add backend + frontend files" && git push',
      '  4. Confirm on github.com that you can browse into each folder listed',
      '     above before redeploying.',
      '  5. Also check Render Settings -> Root Directory is blank (pointing at',
      '     the repo root, not a subfolder).',
      '',
    ].join('\n')
  );
  process.exit(1);
}

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

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'checkout.html')));

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
