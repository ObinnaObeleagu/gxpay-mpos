'use strict';

/**
 * Smoke test for the checkout -> GxPay -> receipt -> status-confirm pipeline.
 *
 * This does NOT need real card reader hardware or GxPay credentials - it
 * hits your own running server (defaults to GXPAY_MODE=mock) with the same
 * shape of payload the browser sends after a real CR100-SCRP card read, and
 * verifies:
 *   1. an approved charge returns a receipt
 *   2. a declined charge (magic test amount) is reported as declined
 *   3. bad/incomplete card data is rejected (400) instead of silently sent on
 *   4. GET status confirms the transaction after the fact
 *
 * Usage:
 *   npm start                 # in one terminal
 *   npm run smoke-test        # in another
 */

const BASE_URL = process.env.SMOKE_TEST_BASE_URL || 'http://localhost:3000';

function samplePayload(overrides = {}) {
  return {
    amount: '10.00',
    currency: 'NGN',
    device: {
      model: 'CR100-SCRP',
      serial: 'DEMO-SERIAL-0001',
      entryMode: 'ICC',
      maskedPan: '535212******4444',
      ksn: 'FFFF9876543210E00000',
      emvTags: '9F26089F2701809F100...', // truncated sample TLV
    },
    ...overrides,
  };
}

async function charge(payload) {
  const res = await fetch(`${BASE_URL}/api/payments/charge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  return { httpStatus: res.status, body };
}

async function status(reference) {
  const res = await fetch(`${BASE_URL}/api/payments/${reference}/status`);
  return { httpStatus: res.status, body: await res.json() };
}

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok - ${label}`);
  } else {
    console.error(`  FAIL - ${label}`);
    failures += 1;
  }
}

async function main() {
  console.log(`Smoke testing against ${BASE_URL}\n`);

  // 1. Health check
  const health = await fetch(`${BASE_URL}/healthz`).then((r) => r.json());
  console.log('1. Health check');
  check('server responded ok', health.status === 'ok');
  console.log(`     gxpayMode=${health.gxpayMode}\n`);

  // 2. Approved charge
  console.log('2. Approved charge (amount 10.00)');
  const approvedRef = `SMOKE-APPROVE-${Date.now()}`;
  const approved = await charge(samplePayload({ reference: approvedRef }));
  check('HTTP 200', approved.httpStatus === 200);
  check('status approved', approved.body.status === 'approved');
  check('receipt present', !!approved.body.receipt);
  check('receipt has masked card only', /^\*+ ?\*+ ?\*+ ?\d{4}$/.test((approved.body.receipt || {}).card || ''));
  check('ICC approval includes an ARPC for the terminal handoff', typeof approved.body.receipt.arpc === 'string' && approved.body.receipt.arpc.length === 16);
  console.log('    receipt:', approved.body.receipt, '\n');

  // 3. Declined charge (magic amount ending .13 -> forces decline in mock mode)
  console.log('3. Declined charge (magic test amount 5.13)');
  const declineRef = `SMOKE-DECLINE-${Date.now()}`;
  const declined = await charge(samplePayload({ amount: '5.13', reference: declineRef }));
  check('HTTP 402', declined.httpStatus === 402);
  check('status declined', declined.body.status === 'declined');
  console.log('    receipt:', declined.body.receipt, '\n');

  // 4. Rejects cleartext card data
  console.log('4. Rejects payload with cleartext PAN');
  const badPayload = samplePayload({
    device: { model: 'CR100-SCRP', entryMode: 'MCR', maskedPan: '535212******4444', cardNumber: '5352121234564444' },
  });
  const rejected = await charge(badPayload);
  check('HTTP 400', rejected.httpStatus === 400);
  check('error mentions cleartext PAN', (rejected.body.errors || []).some((e) => /cleartext/i.test(e)));
  console.log('    errors:', rejected.body.errors, '\n');

  // 5. Status confirmation round trip
  console.log('5. Status confirmation for the approved transaction');
  const confirmed = await status(approvedRef);
  check('HTTP 200', confirmed.httpStatus === 200);
  check('status still approved', confirmed.body.status === 'approved');
  console.log('    status response:', confirmed.body, '\n');

  console.log(failures === 0 ? `All checks passed.` : `${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
