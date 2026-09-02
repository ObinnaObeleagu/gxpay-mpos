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

The reply sent back to the terminal for chip transactions is confirmed
against three independent current Dspread reference implementations
(Android SDK v8.4.9, iOS demo, the original Android readMe -
github.com/DspreadOrg) to be exactly `"8A02" + responseCode` (tag 8A,
Authorization Response Code) - nothing else appended. An earlier version of
this repo also appended a synthetic tag 91 (ARPC) based on a different/older
doc snippet; that's been reverted since a real ARPC is cryptographically
derived by the issuer from the card's specific ARQC, and a fabricated one is
more likely to be rejected by a validating kernel than to help.

### Debugging a "DEVICE_ERROR" (CMDID_DESTRUCT) on insert

This is a low-level session-abort signal from the terminal's own firmware -
see `TransactionResult.DEVICE_ERROR` / `CmdId.CMDID_DESTRUCT` in
`public/dist/js/main.js`. It's not something this app's code controls
directly, and Dspread doesn't publicly document its exact trigger. To
narrow it down:

1. **Open the browser console (F12) during a failed transaction.**
   `Script.js` logs every SDK callback as it fires
   (`onRequestSelectEmvApp`, `onEmvICCExceptionData`,
   `onRequestOnlineProcess`, etc.) - the last callback logged before
   `DEVICE_ERROR` tells you which stage of EMV processing it failed at
   (app selection vs. online authorization vs. after).
2. **Confirm EMV configuration (AID/CAPK) has been loaded onto this
   specific unit.** A terminal with no AID list configured can fail hard on
   any chip transaction. Device settings → Update EMV Config needs a
   config file from Dspread/GxPay/your processor - this app doesn't
   generate one.
3. **Test swipe or tap on the same device/transaction.** If those succeed
   and only insert fails, that strongly localizes the problem to
   chip/EMV-kernel configuration rather than anything in the GxPay
   integration or backend.

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

## Branding

The checkout UI, receipt panel, favicon, and downloadable PDF receipt all use
the GXPAY logo (`public/dist/img/gxpay-logo.png`) and the brand's actual
navy/coral palette (sampled from the logo - see the `:root` custom
properties at the top of `public/dist/css/gxpay-pos.css`). Semantic
approved/declined colors are kept as conventional green/red rather than
brand colors, since that distinction matters more for usability than visual
consistency.

## Receipt PDF export

Every completed transaction can be downloaded as a branded PDF receipt -
click **PDF** in the receipt panel. This calls `GET
/api/payments/:reference/receipt.pdf` (`lib/receiptPdf.js`, built with
`pdfkit`), which renders the same data shown on screen - logo, status badge,
merchant/terminal/reference/amount/masked card/auth code/RRN - and returns
it with `Content-Disposition: attachment` so the browser saves it directly,
no client-side PDF library needed. Only references with a stored receipt
(i.e. the charge attempt got at least as far as a gateway response) can be
downloaded; unknown/pending references return a 404.

## Database (Supabase) - optional persistence

By default this app uses a zero-setup in-memory store for both
transactions and the item catalog (below) - gone on every restart/redeploy,
fine for local dev/demos, not for production. To persist both in a real
Postgres database via [Supabase](https://supabase.com):

1. Create a project at supabase.com
2. Run `db/schema.sql` in the project's SQL Editor (Dashboard -> SQL Editor
   -> New query -> paste the file -> Run) - it creates both the
   `transactions` and `catalog_items` tables in one migration
3. Project Settings -> API -> copy the **Project URL** and the
   **service_role** secret key (NOT the anon/public key)
4. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (`.env` locally, or
   Render's Environment tab in production)

The backend auto-detects which store to use - both env vars set means
Supabase, either blank means in-memory. Nothing else changes; `GET
/healthz` reports which one is active (`storeBackend: "supabase"` or
`"memory"`) so you can confirm at a glance.

**Security note:** the service role key bypasses Row Level Security
entirely and must only ever live server-side, exactly like the GxPay API
credentials - never expose it to the browser. `db/schema.sql` also enables
RLS with a default-deny policy as defense in depth, in case a different
(non-service-role) key is ever used against these tables later.

**What I could verify without your actual Supabase project:** the in-memory
fallback's full behavior (complete smoke test suite passes), and the
*failure* path - pointed the app at deliberately invalid Supabase
credentials and confirmed a charge attempt fails cleanly (500, clear error
message) without crashing the server. I could not do a live round-trip
against a real Supabase project myself - that first real test is worth
running yourself once you add real credentials (the smoke test script,
`npm run smoke-test`, is a good way to do it).

## Items (sale/service catalog) and receipt descriptions

The **Items** tab is a price list: add sale items and services with a name,
price, currency, and type. `db/schema.sql`'s `catalog_items` table backs
it, via the same Supabase/in-memory dual-backend pattern as transactions
(`store/catalogStore.js`, `routes/catalog.js` - full CRUD:
`GET/POST /api/catalog`, `PATCH/DELETE /api/catalog/:id`).

On the **Checkout** tab, an "Item" picker (populated from the same
catalog) sits above Transaction Type. Selecting an item:
- Fills the Amount field with the item's price x quantity (quantity
  defaults to 1, editable next to the picker)
- Matches the currency dropdown to the item's currency
- Sets a receipt description - "Sale of <item name>" for sale items,
  "Payment for <item name>" for services, or "<verb> <qty> x <item name>"
  when quantity > 1

That description flows through the whole system: `POST
/api/payments/charge`'s optional `description` field ->
`buildReceipt()` -> stored with the transaction -> shown as a headline
(above the itemized rows) on the live checkout receipt, the Transactions
tab's list and receipt modal, and the downloadable/printable PDF
(`lib/receiptPdf.js`). A custom-amount charge (no item selected) simply has
no description, exactly like before this feature existed - nothing about
the existing flow changed for that case.

### Seeding 100 sample items

Two ways to populate the catalog with a ready-made, varied set of 100 sale
items and services (groceries, electronics, clothing, haircuts, repairs,
event services, consulting, etc. - NGN 350 to NGN 350,000) for
testing/demos. Both are generated from the same underlying data, so they
produce identical results - pick whichever fits your setup:

- **`db/seed-catalog.sql`** - a plain SQL `INSERT`, for Supabase. Run it in
  the SQL Editor *after* `db/schema.sql`. This is the one to use if you've
  already set up Supabase per the "Database (Supabase)" section above.
- **`scripts/seed-catalog.js`** - a Node script that calls `POST
  /api/catalog` 100 times against a *running* server, so it works
  identically regardless of which backend is active (in-memory or
  Supabase) - useful for local testing without touching Supabase's SQL
  Editor at all:
  ```bash
  npm start                        # in one terminal
  node scripts/seed-catalog.js     # in another - defaults to http://localhost:3000
  # or against a deployed instance:
  BASE_URL=https://your-app.onrender.com node scripts/seed-catalog.js
  ```
  Safe to re-run - there's no duplicate-name check, so running it twice
  creates 200 items, not an error. Delete via the Items tab (or truncate
  `catalog_items` directly in Supabase) for a clean slate first if needed.

Verified end-to-end: ran the Node script against a live local server (all
100/100 created, zero failures - which also confirms the data passes the
exact same `routes/catalog.js` validation Supabase's data goes through),
then confirmed in a real browser that all 100 appear correctly on both the
Items tab's table and the Checkout tab's item picker, and that selecting
one fills the amount/description exactly as expected.

## Reset device (Device settings)

**Use this if contactless (tap) transactions are failing at every amount,
including a trivial one (e.g. NGN 1), while chip/insert transactions still
work fine.** That specific pattern - not "too high an amount" (already
ruled out if a small amount also fails), not a card issue (still fails
right after a successful chip transaction with the same card) - points at
stuck terminal-side session state rather than anything about the card or
transaction.

The "Reset device" button (Device settings -> Terminal Management) existed
in the UI already but was wired to a function, `resetDevice()`, that was
never actually implemented - clicking it silently did nothing. It now sends
the terminal an explicit reset (`mService.resetPosStatus()` / `CMDID_RESET`)
and waits for the device's own acknowledgment before telling you it's safe
to try again - confirmed in a real browser test, including the transient
"Resetting device..." (blue) -> "Device reset complete" (green) status
sequence.

This is a **deliberate, standalone, operator-triggered action** - it is
never run automatically before checkout. An earlier version of `checkout()`
did call this immediately before every trade attempt, and real-device trace
evidence showed the very next command landing before the device had
actually finished settling from the reset, itself triggering a
`DEVICE_ERROR` abort (see "Debugging DEVICE_ERROR" below). Firing it here on
its own, with real time to complete before you start a new transaction,
avoids that same race condition.

**If a reset doesn't clear a stuck contactless session**, that's real
evidence the issue has moved from "something fixable in software" to a
genuine firmware/hardware question - a full power cycle of the terminal is
the next thing to try, and if that doesn't help either, it's worth raising
with Dspread directly with the device's serial/firmware version. There's no
NFC-specific reset command exposed anywhere in `main.js` - this general
device-level reset is the closest thing the SDK provides.

## PIN entry modal

`onRequestSetPin()` fires when a chip transaction needs a PIN and the
terminal has no embedded PIN pad of its own. The original stock demo
handled this with `dialog()` - the browser's native `window.prompt()`,
pre-filled with a hardcoded `"123456"` default. Beyond looking out of place,
that had two real problems: the PIN displayed in **plain, unmasked text**,
and the hardcoded default could get submitted by accident if someone just
hit Enter without clearing it first.

Replaced with a proper branded modal (`#pinModal` in `checkout.html`) - a
masked (`type="password"`) input plus an on-screen numeric keypad, styled
to match the rest of the app. Verified in a real browser: the field starts
empty (no default to accidentally submit), the entered value never appears
anywhere in the trace log (only a `*`-masked length is traced), real
keyboard typing works alongside the on-screen keypad, and Cancel calls
`mService.sendPin("")` rather than leaving the terminal with no response at
all - confirmed against `main.js` that an empty string is an intentional,
distinct "no PIN provided" signal the SDK already supports, not an
undefined edge case.

## Transactions tab

The **Transactions** tab (next to Checkout) lists every transaction the
backend has recorded (`GET /api/payments`, `store/transactionStore.js`),
most recent first, with an optional status filter. Clicking **View** on any
row opens the same receipt UI as the live checkout flow, with two actions:

- **Reprint** - triggers the browser print dialog (`window.print()`),
  reusing the exact same print-only CSS (`.gx-receipt-print-area`) as a
  live checkout receipt
- **PDF** - re-downloads the receipt PDF via the existing `GET
  /api/payments/:reference/receipt.pdf` endpoint - no new PDF-generation
  code, this is the same route the live checkout's "PDF" button already
  used

No new backend capability was needed for reprint/reissue beyond the list
endpoint itself - both actions reuse routes that already existed for the
live checkout flow. As with the rest of this project,
`store/transactionStore.js` is in-memory and resets on restart/redeploy -
the Transactions tab will only show what's happened since the server last
restarted, until you swap in a real database (see the note already in that
file).

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

## Debugging DEVICE_ERROR (CMDID_DESTRUCT) on chip transactions

If chip (insert) transactions fail with the terminal aborting mid-session
(`DEVICE_ERROR` in the transaction status feed), this is an undocumented
low-level firmware abort - Dspread's SDK reference docs list it as an enum
value but never document what triggers it, across every language SDK they
publish.

The Transaction Status panel is a **live, append-only trace** of every
device/EMV callback that fires, with timestamps - it does not need the
browser console open. When this happens, read the trace top to bottom and
check:

1. **Does it get past "Chip inserted - device requested online
   authorization"?** If not, the failure is happening before GxPay is even
   contacted - purely a device/EMV-kernel issue unrelated to the payment
   integration.
2. **Does "Device requested PIN entry" appear?** If so and nothing sends a
   PIN back (this repo doesn't implement PIN capture yet - see the comment
   on `onRequestSetPin` in `Script.js`), the terminal is very likely timing
   out waiting for a PIN that never arrives. Test with a card/CVM
   configuration that doesn't require PIN entry to confirm.
3. **Does "GxPay responded" appear before DEVICE_ERROR?** If GxPay/mock
   responded but the terminal still aborts, the reply TLV
   (`buildOnlineAuthTlv()` in `paymentProcessor.js`) is the next thing to
   scrutinize - though it's currently confirmed against three independent
   Dspread reference SDKs (Android, iOS, and the original readMe) sending
   exactly `8A02<code>` with nothing appended.
4. **RESOLVED on one real device (DEVICE_ERROR, wrong cause):** an earlier
   version of `checkout()` called `mService.resetPosStatus()` before every
   new charge, as a precaution against stale session state from a prior
   incomplete transaction. Trace log evidence showed this backfiring: the
   reset's own acknowledgment comes back through the SDK's generic response
   dispatcher as `onError(DEVICE_RESET)`, and the very next command
   (`doTrade()`, fired only 200ms later) was landing while the device was
   still settling from that reset - triggering `CMDID_DESTRUCT`
   ("DEVICE_ERROR") almost immediately, before a card could even be
   presented. The reset call has been removed - `doTrade()` is called
   directly, matching the original stock demo's proven-working behavior.
5. **RESOLVED (real root cause on that device): missing/wrong EMV
   configuration.** `DEVICE_ERROR` on insert, while swipe/tap worked fine,
   pointed at the EMV kernel specifically (swipe/tap never touch it - see
   "How chip vs. swipe/tap differ" above). The device had no CR100-SCRP-
   specific AID/CAPK configuration loaded. Loading the *correct* profile
   (from Dspread, matched to this exact terminal - **not** a generic or
   other-vendor EMV profile; a profile built for a different terminal
   model/vendor can *load* without erroring, since the uploader here just
   structurally parses TLV entries and doesn't validate vendor-specific
   proprietary tags, but produces a kernel configuration that doesn't
   actually work) resolved it completely - full chip transactions now
   complete end to end.
6. **RESOLVED: receipt never appeared / status stuck on "Authorizing..."
   despite a genuinely approved payment.** Real trace logs from a working
   transaction revealed a second bug once #5 was fixed: `onDoTradeResult`
   fires with `"ICC"` the moment a chip is first *detected* - well before
   EMV processing or GxPay authorization even start, despite the SDK's
   naming suggesting otherwise. The code was wrongly treating that early
   event as the transaction's completion signal, so the receipt-rendering
   code ran too early (before GxPay had even been called) and never ran
   again. The **actual** completion signal for a chip transaction is
   `onRequestTransactionResult('APPROVED')`, which fires later, once the
   card's cryptogram exchange genuinely finishes - `paymentProcessor.js` now
   renders the receipt from there instead (`onTransactionApproved()`),
   using the GxPay result already stored during the online-authorization
   step.
7. **RESOLVED: NFC/tap transactions fail with `NFC_TERMINATED` above a
   certain amount, while smaller tap amounts and all chip transactions
   work fine.** This is **not a bug** - confirmed via real-device testing
   (₦100 approved cleanly via tap with a full GxPay round trip; ₦9,000 with
   the same card hit `NFC_TERMINATED` before the device ever handed card
   data to the app - no "card read" trace line at all, meaning the
   termination happens inside the terminal's own contactless kernel,
   before reaching any of this app's code). This is standard EMV behavior:
   card networks intentionally cap contactless ("tap to pay") transactions
   below a Contactless Transaction Limit and require chip+PIN above it, for
   security. `Script.js`'s `onRequestTransactionResult` now shows a clear,
   actionable message for this specific code ("Amount too high for tap.
   Please insert the card instead.") instead of the raw device code - the
   technical detail is still traced first, so it's not lost for future
   debugging.

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
