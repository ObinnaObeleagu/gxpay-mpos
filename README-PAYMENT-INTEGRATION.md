# CR100-SCRP Web Checkout + GxPay Gateway Integration

This is the Dspread QPOS/mPOS **Web SDK demo** (`checkout.html` + the
`dist/js/*.js` device SDK), reworked so the payment-processing section
actually authorizes transactions against the **GxPay** gateway instead of
just displaying raw card data on screen, and packaged to run as a normal
Node/Express app you can deploy to **Render**.

## What changed vs. the original demo

The original `Script.js`:

- **Displayed raw track1/track2/PAN/expiry/PIN-block data directly on the
  page** whenever a card was swiped or tapped (`onDoTradeResult`'s `MCR` /
  `NFC_ONLINE` branches). That's cardholder data in the DOM - never do this.
- **Hardcoded chip (EMV) authorization to always approve**
  (`onRequestOnlineProcess` sent back `"8A023030"` - "approved" - for every
  chip transaction, without ever contacting a payment processor).
- Had no backend at all - nothing called a gateway, nothing produced a
  receipt, nothing confirmed a transaction status.
- Was built on the full AdminLTE dashboard template - sidebar, navbar,
  dozens of unused plugins, and a "You load dspread Web demo, this file is
  only created for testing purposes!" popup on every load.

This rework:

- Adds a small Express backend (`server.js`, `routes/`, `services/`,
  `store/`, `lib/`) that is the **only** thing that ever talks to GxPay.
  The browser never holds a GxPay API key/secret.
- Replaces the hardcoded EMV approval with a real authorization call to
  GxPay during `onRequestOnlineProcess` (see "How chip vs. swipe/tap differ"
  below).
- Replaces the raw on-screen card dump with a masked receipt (`**** **** ****
  1234`) rendered from what the gateway actually returned.
- **Rebuilt as GXPAY POS**: dropped the AdminLTE dashboard shell (sidebar,
  navbar, treeview, the testing-purposes popup) entirely in favor of a
  custom, single-purpose checkout UI - a top bar, a two-panel checkout card
  (amount/status on the left, live transaction feed + receipt on the right),
  and terminal setup (connect, device info, EMV/firmware updates) tucked
  into a small "Device settings" panel instead of cluttering the main flow.
  New design system in `public/dist/css/gxpay-pos.css` (jade-green brand
  color, Space Grotesk/Inter/IBM Plex Mono type, a receipt styled as a torn
  paper slip). No jQuery/Bootstrap dependency - the device settings panel is
  a small hand-rolled dependency-free modal (`public/dist/js/uiModal.js`).
- Trims the AdminLTE plugins/build toolchain that this checkout page never
  used down to just what's actually loaded (Font Awesome only) - `public/`
  went from 61MB to about 3.5MB - and removes the original AdminLTE CSS/JS
  build toolchain from `package.json` (it had a broken peer-dependency tree
  and a native `node-sass` build - neither is needed at runtime).

## Architecture

```
Browser (public/checkout.html)
  |  card read (already DUKPT/3DES-encrypted by the CR100-SCRP hardware,
  |  or EMV TLV tags for chip) - never a cleartext PAN/track/PIN
  v
Express backend (server.js, routes/payments.js)
  |  masks/validates, never logs full card data
  v
services/gxpayClient.js  --HTTPS-->  GxPay gateway
  |
  v
store/transactionStore.js (receipt + status, for confirm/reconciliation)
```

- `public/checkout.html` + `public/dist/js/Script.js` - Dspread SDK wiring
  (Bluetooth/USB connect, EMV config updates, firmware updates). Mostly
  unchanged except the payment-related callbacks now delegate to
  `paymentProcessor.js` instead of writing to the DOM directly.
- `public/dist/js/paymentProcessor.js` - **new**. Owns the checkout button,
  card-status UI, and the fetch() calls to our backend.
- `public/dist/js/uiModal.js` - **new**. Tiny dependency-free open/close
  controller for the "Device settings" panel.
- `public/dist/css/gxpay-pos.css` - **new**. The GXPAY POS design system
  (colors, type, every component on the page).
- `routes/payments.js` - `POST /api/payments/charge`, `GET
  /api/payments/:reference/status`, `POST /api/payments/webhook/gxpay`.
- `services/gxpayClient.js` - the only module that calls GxPay. Has a `mock`
  mode (default) that simulates GxPay so you can test the whole flow with no
  live credentials.
- `lib/cardPayload.js` - validates/masks whatever the device sends up before
  it's used, and actively rejects anything that looks like a cleartext PAN.
- `store/transactionStore.js` - in-memory transaction store (swap for a real
  DB before production - see below).

## How chip (ICC) vs. swipe/tap (MCR/NFC) differ

This matters because it changes *when* GxPay gets called:

- **Chip (ICC):** the terminal needs an online authorization response
  *before* it can finish the EMV cryptogram exchange with the card. That
  happens in `onRequestOnlineProcess` - this is now where
  `paymentProcessor.js` calls `POST /api/payments/charge` and waits for
  GxPay's response before telling the device to approve or decline
  (`mService.sendOnlineProcessResult(...)`). By the time `onDoTradeResult`
  fires with `"ICC"`, the card has already finished and we just render the
  receipt from the result we already have.
- **Swipe (MCR) / contactless-magstripe (NFC_ONLINE):** the full,
  already-encrypted card read comes back directly in `onDoTradeResult` - no
  separate online-authorization step in this SDK - so the charge is
  submitted there instead.

**Known issue this repo already fixes:** the reply sent back to the
terminal for an approved chip transaction must include tag **91** (the
issuer's authentication data / ARPC), not just tag 8A (the response code).
Dspread's own SDK reference shows the full reply as `WriteBackIc(tag 8A+tag
91+tag 71/71)`. Sending tag 8A alone causes some terminal/EMV-kernel
configurations to hard-abort the session (`CMDID_DESTRUCT`, surfaced to the
app as `DEVICE_ERROR`) right at that handoff point instead of completing
normally - `paymentProcessor.js`'s `buildOnlineAuthTlv()` now includes tag
91 whenever the gateway response has one, and the mock gateway generates a
plausible one so this is testable without live GxPay credentials. Issuer
scripts (tags 71/72) are *not* relayed - confirm with GxPay/Dspread whether
your setup ever needs them before going live.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`. With the default `GXPAY_MODE=mock`, the full
checkout flow works without a physical reader or GxPay credentials (see
"Testing without hardware" below).

### Going live with GxPay

I could not pull GxPay's authenticated API reference
(`https://merchant-api-dev.gxpay.net/api/v1/docs` and their Postman
workspace both require a merchant login), so `services/gxpayClient.js` is
built against a best-effort, industry-standard request/response shape with
every assumption tagged `// CONFIRM:`. Before switching `GXPAY_MODE` to
`sandbox`/`live`:

1. Get your GxPay merchant credentials and API docs from your GxPay account
   rep/dashboard.
2. In `services/gxpayClient.js`, check `buildChargePayload()` (our request ->
   GxPay's body) and `normalizeGxPayResponse()` (GxPay's response -> ours)
   against the real contract - field names, whether amount is minor or major
   units, the actual endpoint paths, and the auth/signing scheme
   (`GXPAY_SIGNING=bearer` vs `hmac`).
3. Fill in `.env`: `GXPAY_BASE_URL`, `GXPAY_API_KEY`, `GXPAY_API_SECRET`,
   `GXPAY_MERCHANT_ID`, `GXPAY_TERMINAL_ID`.
4. For chip transactions specifically, confirm with GxPay + Dspread what the
   full EMV online-authorization exchange needs beyond the response code
   (tag `8A`) - typically the issuer's ARPC (tag `91`) and any issuer
   scripts (tags `71`/`72`) also need to be relayed back to the card via the
   Dspread SDK. `onOnlineAuthorizationRequest()` in `paymentProcessor.js`
   currently only sends the response code, which is enough to approve/
   decline but may not be a complete EMV-certified exchange - this needs
   sign-off from whoever holds your EMV kernel certification.

## Deploying to Render

**Option A - Blueprint (recommended):** push this repo to GitHub, then in
Render: New -> Blueprint -> point at the repo. `render.yaml` defines the
service, health check (`/healthz`), and env vars (secrets are marked
`sync: false` so Render prompts you for them rather than storing defaults in
git).

**Option B - manual Web Service:** New -> Web Service -> connect the repo ->
Runtime: Node -> Build Command: `npm install` -> Start Command: `npm start`.
Then add the `GXPAY_*` env vars from `.env.example` under the Environment
tab.

**Option C - Docker:** the included `Dockerfile` also works if you'd rather
deploy Render's Docker runtime (or run it anywhere else with `docker build
&& docker run`).

Either way, once deployed, `GET https://<your-service>.onrender.com/healthz`
should return `{"status":"ok","gxpayMode":"..."}`.

### Troubleshooting Render deploys

**`failed to compute cache key: ... "/public": not found`** (Docker build
error) - this means the `public/` folder isn't actually present in whatever
Render is building from. It's not a Dockerfile bug; the Dockerfile now fails
fast with a clearer message if this happens (`RUN test -f
public/checkout.html || ...`), and `server.js` does the same check at
startup for the native Node runtime. To fix it:

1. **Check the folder is actually in your GitHub repo.** Open your repo on
   github.com and confirm you can browse into `public/checkout.html`,
   `public/dist/`, and `public/plugins/`. If it's not there, it wasn't
   committed - re-add it (`git add public && git commit -m "add public" &&
   git push`) from the repo root, not from inside a subfolder.
2. **Check Render's "Root Directory" setting** (Service -> Settings ->
   Build & Deploy). If it's set to anything other than blank/`.`, Render is
   looking for `public/` inside that subdirectory instead of the repo root.
3. **If you didn't intend to use Docker:** Render auto-detects the
   `Dockerfile` and may default new Web Services to the Docker environment.
   Unless you specifically want a Docker deploy, switch the service's
   **Environment/Runtime to "Node"** instead (or delete/rename the
   Dockerfile) and use Build Command `npm install`, Start Command `npm
   start` - this skips Docker entirely and is simpler to debug, since a
   missing `public/` will then show as a clear `FATAL: ... not found` line
   in the deploy logs instead of a Docker checksum error. This is also what
   `render.yaml` (Option A above) sets up automatically.
4. **`package-lock.json` missing:** if you deleted/regenerated it locally,
   commit the current one (`npm install` then `git add package-lock.json`) -
   the Dockerfile's `package-lock.json*` copies it if present but the app
   will build fine either way.

**`Error: Cannot find module './config/env'`** (or `'./routes/payments'`,
etc.) - same root cause as above: one of the app's own folders
(`config/`, `routes/`, `services/`, `store/`, `lib/`) wasn't pushed to the
repo/branch Render is deploying from. `server.js` now runs a preflight
check before requiring anything, so instead of a bare `MODULE_NOT_FOUND`
stack trace, your deploy logs will show exactly which files are missing and
what's actually present at the top level - follow the steps it prints
(`git status`, `git add <folder>`, commit, push, verify on github.com).
This is almost always caused by only some of the reworked folders having
been committed when the project was first pushed to a new repo - double
check every one of `config/`, `routes/`, `services/`, `store/`, `lib/`,
`public/` shows up when you browse the repo on GitHub.

## Testing without hardware

`scripts/smoke-test.js` exercises the exact flow you described - card
detected, amount entered, checkout, GxPay call, receipt returned, status
confirmed - against your own running server, with no reader or GxPay
credentials needed:

```bash
npm start                 # terminal 1
npm run smoke-test        # terminal 2
```

It checks:
1. Health check responds
2. An approved charge (amount `10.00`) returns a masked-card receipt
3. A **declined** charge - any amount ending in **.13** (e.g. `5.13`)
   forces a decline in mock mode, so you can see that path too
4. A payload with a cleartext PAN is **rejected with HTTP 400** rather than
   silently forwarded
5. `GET /api/payments/:reference/status` confirms the transaction afterward

## Testing with the real CR100-SCRP

1. Start the server (`npm start`, `GXPAY_MODE=mock` is fine for this).
2. Open the checkout page in a browser that supports Web Bluetooth (Chrome/
   Edge over HTTPS, or `http://localhost` which Chrome treats as a secure
   context).
3. Click **Connect** in the top nav, pair the CR100-SCRP. The card-status
   panel should move from "Not connected" to showing the device once
   paired.
4. Enter an amount, click **Checkout / Pay**.
   - Card status changes to "Please insert, swipe, or tap your card now."
     (**card detection is displayed**, per your requirement).
5. Present a card (insert/swipe/tap).
   - Status moves to "Card detected... Authorizing with GxPay" /
     "...Sending to GxPay...".
   - The backend calls GxPay (**or the mock**, depending on `GXPAY_MODE`).
6. On response, the **receipt panel appears** with masked card, amount,
   auth code, RRN, gateway reference, and Approved/Declined status (**receipt
   sent back to the app**).
7. Click **Confirm Status** to re-query `/api/payments/:reference/status`
   (**status confirmation**) - useful to demonstrate reconciliation even
   though this integration currently gets its answer synchronously from the
   charge call itself.

## Known SDK bug fixed: chip cards declined offline used to hang forever

If a chip card is **declined offline** by the card itself (a normal EMV
outcome - the card's own risk management rejects the transaction without
ever going online, distinct from the online-authorization path this
integration adds GxPay to), the underlying Dspread SDK core (`main.js`) has
a pre-existing typo: it calls `mListener.onReqestDisplay(...)` (missing the
"u" in "Request") instead of the correctly-spelled `onRequestDisplay` used
everywhere else in the SDK. Since nothing implemented the misspelled method,
calling it threw an uncaught exception *inside* the SDK's own processing
chain - which silently aborted the very next two calls in that same
statement, including `onRequestTransactionResult(TransactionResult.DECLINED)`.
The practical symptom: insert a card that gets offline-declined, and the
page hangs on "Waiting for card..." forever with no error, no decline
message, nothing - because the app was never actually told the card was
declined.

This is fixed in `Script.js` by implementing the misspelled method (so the
SDK's call succeeds) and by making `onRequestTransactionResult` actually
surface non-approved outcomes to the operator - previously it was a no-op
that assumed GxPay's response would always be the source of truth, which
isn't true for offline declines since GxPay is never contacted in that path.

**If you're still seeing "insert card -> nothing happens" after this fix**,
it's almost certainly no longer a software bug - work through these in
order:
1. **Check the browser console** (F12 -> Console) at the moment of card
   insertion. Every SDK callback logs (`onRequestWaitingUser`,
   `onRequestSelectEmvApp`, `onRequestSetPin`, `onRequestOnlineProcess`,
   `onDoTradeResult`, etc.) - whichever one *doesn't* appear tells you
   exactly where the device stopped responding.
2. **Try a swipe or contactless tap** instead of insert, and/or a different
   card. If *no* entry mode ever produces a console log, the issue is
   below the app layer entirely (Bluetooth session, reader hardware).
3. **Confirm EMV/AID configuration has been loaded onto this specific unit.**
   A chip reader with missing or mismatched AID/kernel config will often
   ignore inserted chip cards without any host notification at all - this
   is the single most common real-world cause of exactly this symptom on a
   freshly unboxed or uncertified terminal. Use Device settings -> Update
   EMV config (needs the config file from Dspread/GxPay's onboarding team),
   or confirm with them directly that this CR100-SCRP has valid config for
   the card schemes you're testing.
4. **Use a certified EMV test card** if you're in a sandbox/certification
   environment - not every physical card will be recognized by a
   test-mode AID configuration.
5. **Reconnect the reader** (disconnect and reconnect via the top-bar
   Connect control) in case the BLE session is connected-but-stale.

## Security & PCI notes (read before going live)

- **Never let a cleartext PAN, full track, or PIN reach the browser's DOM or
  server logs.** `lib/cardPayload.js` actively rejects payloads that look
  like a cleartext PAN as a safety net, but the real control is upstream:
  confirm your CR100-SCRP is configured for encrypted-track/DUKPT output
  (KSN + ciphertext), not cleartext magstripe data. The PIN block was
  already encrypted in the original demo (standard for any PIN pad) - that
  part was fine; the PAN/track display was the actual problem, and this
  rework removes it.
- This demo has **not** been PCI-assessed. Running a card-present integration
  with an encrypting reader typically falls under **SAQ P2PE** (if fully
  P2PE-validated end to end) or **SAQ B-IP/C** otherwise - work with your
  QSA/GxPay's compliance team to determine which applies to your specific
  CR100-SCRP configuration and hosting setup before processing real cards.
- `store/transactionStore.js` is an **in-memory Map** - it's gone on every
  restart/redeploy. Fine for testing; replace with a real database
  (Postgres, etc.) before production so transactions survive restarts and
  are queryable for chargebacks/reconciliation.
- Rate limiting (`express-rate-limit`) and `helmet` are already wired up in
  `server.js`; tighten `ALLOWED_ORIGIN` (currently `*`) to your real domain
  before going live.
- The webhook receiver (`POST /api/payments/webhook/gxpay`) verifies an
  HMAC signature if `GXPAY_WEBHOOK_SECRET` is set - confirm GxPay's actual
  webhook signing scheme (header name, algorithm) before relying on it.

## Environment variables

See `.env.example` for the full list with descriptions. The important ones:

| Variable | Purpose |
|---|---|
| `GXPAY_MODE` | `mock` (default, no credentials needed) / `sandbox` / `live` |
| `GXPAY_BASE_URL`, `GXPAY_API_KEY`, `GXPAY_API_SECRET` | GxPay credentials |
| `GXPAY_MERCHANT_ID`, `GXPAY_TERMINAL_ID` | Your GxPay merchant/terminal IDs |
| `GXPAY_SIGNING` | `bearer` or `hmac` - confirm against GxPay's docs |
| `PORT`, `ALLOWED_ORIGIN` | Server/CORS config |

## What's intentionally not solved here

- The exact GxPay request/response field names (flagged `// CONFIRM:` in
  `services/gxpayClient.js`) - needs your GxPay merchant docs/Postman
  collection.
- Full EMV online-authorization data beyond the response code (ARPC, issuer
  scripts) for chip transactions - needs sign-off from your EMV kernel
  certification holder.
- A persistent transaction store/database.
- PCI compliance validation - this is an engineering starting point, not a
  substitute for a QSA assessment.
