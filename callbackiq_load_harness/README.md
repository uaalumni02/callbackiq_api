# CallBackIQ Real-Activity, Attribution & Load Harness

This harness exercises the two existing businesses only:

- Atlanta Pro Plumbing & Drain — `6a33ff7944ce80eaef2cb543` — `+14709052202`
- Birmingham Plumbing — `6a7e69e15ab394844b6ed9d2` — `+12058397006`

It never calls registration, trial activation, A2P onboarding, Twilio number purchase, business-number provisioning, or tracking-number provisioning endpoints.

## Environment loading

The script automatically loads:

1. `callbackiq_api/.env`
2. optional `callbackiq_load_harness/.env`
3. shell variables override both

You therefore run it as:

```bash
node callbackiq-real-activity-load.mjs attribution
```

Do not use `node --env-file=.env` unless you intentionally created such a file.

The harness `.env` is mainly for the two existing owner login credentials and load-test overrides. The API's MongoDB/Twilio values can remain in the parent API `.env`.

## Attribution mode

`attribution` creates temporary fake tracking-number records through the API repository's current Mongoose models. No Twilio provisioning request occurs.

Default fake assigned numbers use the reserved fictional NANP range:

- Atlanta: `+12125550110`, `+12125550111`, `+12125550112`
- Birmingham: `+12135550110`, `+12135550111`, `+12135550112`

For each fixture it checks:

- MarketingSource creation and owner API visibility
- fake TrackingNumber assignment to the correct tenant/source
- the app's `resolveTwilioNumberContext` function when that export is discoverable
- a correctly signed harmless `/api/twilio/status` `queued` routing probe
- attributed CallLog persistence and owner API visibility
- Lead and Conversation attribution persistence/read paths
- automatic Lead/Conversation propagation as a diagnostic; enable `STRICT_ATTRIBUTION_PROPAGATION=yes` if you want generic create-path propagation to fail the run
- appointment attribution inheritance for the first source per business when an available slot exists
- cross-tenant isolation
- cleanup by default

The status probe uses `CallStatus=queued`, so it does not deliberately trigger missed-call recovery SMS, AI qualification, number purchase, or a phone call.

## Install/update

```bash
cd "$HOME/Documents/callbackiq_api"
unzip -o "$HOME/Downloads/callbackiq_load_harness.zip"
cd callbackiq_load_harness
```

Create the optional harness config once:

```bash
cp -n .env.example .env
code .env
```

Set these four values in that file:

```text
LOGIN_ATLANTA=YOUR_EXISTING_ATLANTA_LOGIN
PASSWORD_ATLANTA=YOUR_EXISTING_ATLANTA_PASSWORD
LOGIN_BIRMINGHAM=YOUR_EXISTING_BIRMINGHAM_LOGIN
PASSWORD_BIRMINGHAM=YOUR_EXISTING_BIRMINGHAM_PASSWORD
```

If you already use `COOKIE_*` or `BEARER_*`, those can be used instead.

If the API receives requests locally but validates Twilio signatures against ngrok, add:

```text
TWILIO_WEBHOOK_SIGNATURE_BASE_URL=https://YOUR-NGROK-DOMAIN.ngrok-free.app
```

## Recommended sequence

### 1. Preflight

```bash
cd "$HOME/Documents/callbackiq_api/callbackiq_load_harness"
node callbackiq-real-activity-load.mjs preflight
```

### 2. Fake-number attribution

```bash
ALLOW_SYNTHETIC_WRITES=yes \
ALLOW_ATTRIBUTION_FIXTURES=yes \
ATTRIBUTION_NUMBERS_PER_BUSINESS=3 \
node callbackiq-real-activity-load.mjs attribution
```

Fixtures are deleted automatically.

To leave them temporarily for UI inspection:

```bash
ALLOW_SYNTHETIC_WRITES=yes \
ALLOW_ATTRIBUTION_FIXTURES=yes \
KEEP_ATTRIBUTION_FIXTURES=yes \
node callbackiq-real-activity-load.mjs attribution
```

Use that only on staging/test data.

To make generic Lead/Conversation create-path attribution propagation mandatory:

```bash
ALLOW_SYNTHETIC_WRITES=yes \
ALLOW_ATTRIBUTION_FIXTURES=yes \
STRICT_ATTRIBUTION_PROPAGATION=yes \
node callbackiq-real-activity-load.mjs attribution
```

### 3. 200 synthetic customer flows

```bash
ALLOW_SYNTHETIC_WRITES=yes \
LOAD_CONCURRENCY=20 \
LOAD_FLOWS_PER_BUSINESS=100 \
node callbackiq-real-activity-load.mjs load
```

### 4. 1,000 synthetic customer flows

```bash
ALLOW_SYNTHETIC_WRITES=yes \
LOAD_CONCURRENCY=50 \
LOAD_FLOWS_PER_BUSINESS=500 \
node callbackiq-real-activity-load.mjs load
```

### 5. Complete non-provider run

```bash
ALLOW_SYNTHETIC_WRITES=yes \
ALLOW_ATTRIBUTION_FIXTURES=yes \
LOAD_CONCURRENCY=30 \
LOAD_FLOWS_PER_BUSINESS=250 \
node callbackiq-real-activity-load.mjs safe-full
```

This runs preflight → load → attribution → appointment holds → UI smoke. UI smoke requires Playwright.

### 6. Provider webhook smoke

This can cause real SMS/AI/voice side effects depending on business settings:

```bash
ALLOW_PROVIDER_SIDE_EFFECTS=yes \
PROVIDER_WEBHOOK_FLOWS_PER_BUSINESS=2 \
node callbackiq-real-activity-load.mjs webhooks
```

### 7. Two real phone calls

Requires an existing separate Twilio/verified caller ID:

```bash
ALLOW_LIVE_CALLS=yes \
MAX_LIVE_CALLS_TOTAL=2 \
node callbackiq-real-activity-load.mjs live-calls
```

The script never creates or purchases a number.

## UI dependency

For `ui`, `safe-full`, or `provider-full`:

```bash
cd "$HOME/Documents/callbackiq_api"
npm install --save-dev playwright
npx playwright install chromium
```

## Reports

Reports are written under `callbackiq_load_harness/reports/` by default. Attribution results include the fake number, source/tracking IDs, call/lead/conversation IDs, routing result, resolver result when available, attribution snapshots, appointment inheritance, and tenant-isolation result.

A strong result is zero unexpected 5xx responses, zero tenant leaks, zero fake-number routing/resolver failures, correct CallLog attribution, correct appointment inheritance when a slot exists, and stable p95/p99 latency as concurrency increases.

## Schema compatibility notes

The attribution fixture mode accepts either `MONGO_URL` or `MONGODB_URI` from the API environment. It also derives normalized required key fields such as `MarketingSource.nameKey` from the synthetic source name rather than bypassing model validation. Fake tracking numbers remain database-only fixtures; the harness never calls the tracking-number provisioning endpoint.
