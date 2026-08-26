# CallBackIQ Voice Load Testing

This kit is designed for the current CallBackIQ API voice architecture: signed Twilio voice webhooks, `/ws/voice` ConversationRelay, distributed pending-connection leases, per-business voice capacity, voice usage reservations, and the existing Phase 9 live smoke test.

## Safety model

Use a dedicated database such as `callbackiq_voice_load`. The seeded business has `missedCallSmsEnabled=false`, so any fallback/abandonment recovery is suppressed before Twilio SMS delivery is attempted. The bulk scripts never place PSTN calls. AI mode is opt-in because it can consume OpenAI tokens. Real Twilio calls remain in the repository's existing `scripts/verify-phase9-live.js` and should only be used as a small final smoke test.

Do not run the DB-writing load modes against production.

## 1. Install

From the API repository root, run the installer from the downloaded kit directory:

```bash
node /path/to/callbackiq_voice_load_kit/install-voice-load-kit.mjs "$PWD"
```

Then confirm:

```bash
npm run | grep 'voice-load\|perf:voice'
```

## 2. Create a dedicated environment

Copy your local environment file:

```bash
cp .env .env.voice-load
```

Edit `.env.voice-load` in VS Code. Change the MongoDB database name to a dedicated load-test DB and add/override these values:

```dotenv
NODE_ENV=development
PROCESS_ROLE=api
PORT=3000

# IMPORTANT: separate database, not your normal development/prod database.
MONGODB_URI=mongodb://127.0.0.1:27017/callbackiq_voice_load

# These only need to be internally consistent for signed local requests.
TWILIO_ACCOUNT_SID=AC00000000000000000000000000000000
TWILIO_AUTH_TOKEN=callbackiq_voice_load_only_token
TWILIO_VALIDATE_WEBHOOKS=true
TWILIO_WEBHOOK_BASE_URL=https://voice-load.callbackiq.invalid
VOICE_HTTP_PUBLIC_URL=https://voice-load.callbackiq.invalid
VOICE_WEBSOCKET_PUBLIC_URL=wss://voice-load.callbackiq.invalid/ws/voice

VOICE_LOAD_TO=+12025550123
VOICE_LOAD_MAX_CONCURRENT=25
VOICE_LOAD_ALLOW_DB_WRITES=true
```

If your normal environment contains required app values (JWT secret, client URL, etc.), keep valid local values in `.env.voice-load`. The load-specific values above should replace the corresponding production/development provider values.

## 3. Seed the synthetic voice business

```bash
DOTENV_CONFIG_PATH=.env.voice-load npm run voice-load:seed
```

Expected important fields:

```text
trackingNumberStatus: active
voiceAiEnabled: true
missedCallSmsEnabled: false
answerMode: always
maxConcurrentCalls: 25
```

## 4. Start the API with the load-test environment

In terminal 1:

```bash
DOTENV_CONFIG_PATH=.env.voice-load npm run start:dev
```

Verify it is using the load database before continuing.

## 5. Run the zero-provider transport benchmark

This starts an in-process ConversationRelay server and uses stubbed dependencies. It tests the actual websocket transport, frame parsing, message serialization, timers and turn handling without MongoDB, OpenAI or Twilio.

In terminal 2:

```bash
npm run perf:voice:transport
```

Larger run:

```bash
VOICE_TRANSPORT_CLIENTS=500 \
VOICE_TRANSPORT_CONCURRENCY=100 \
VOICE_TRANSPORT_TURNS=3 \
npm run perf:voice:transport
```

Watch `failures`, p95/p99 connection latency, and simulated turn latency.

## 6. Run signed `/voice` webhook load

This hits the real local API with unique, validly signed synthetic calls. It creates real CallBackIQ voice sessions/leads/conversations/call logs in the dedicated load database. It performs one preflight first and aborts the bulk run unless the business routes to ConversationRelay.

```bash
DOTENV_CONFIG_PATH=.env.voice-load \
VOICE_LOAD_REQUESTS=100 \
VOICE_LOAD_CONCURRENCY=10 \
npm run perf:voice:webhook
```

Then scale:

```bash
DOTENV_CONFIG_PATH=.env.voice-load \
VOICE_LOAD_REQUESTS=500 \
VOICE_LOAD_CONCURRENCY=25 \
npm run perf:voice:webhook
```

Primary metrics: requests/sec, p50/p95/p99 latency, HTTP status counts, and route counts. `relay` should equal the request count.

## 7. Test the atomic 25-call capacity limit directly

This stresses the real Mongo-backed `VoiceCapacityService` with 50 simultaneous acquisitions and verifies the first 25 are accepted, the remainder are rejected, and every accepted lease is released.

```bash
DOTENV_CONFIG_PATH=.env.voice-load \
VOICE_CAPACITY_ATTEMPTS=50 \
VOICE_CAPACITY_EXPECT_MAX=25 \
npm run perf:voice:capacity
```

Expected:

```text
accepted: 25
denied: 25
activeBeforeRelease: 25
activeAfterRelease: 0
```

## 8. Integrated ConversationRelay capacity test

This is the highest-value synthetic test. For every virtual caller it:

1. sends a signed `/api/twilio/voice` webhook;
2. verifies the returned TwiML selects ConversationRelay;
3. extracts the real `voiceSessionId` and `businessId`;
4. opens a validly signed `/ws/voice` connection;
5. sends the real ConversationRelay `setup` frame;
6. holds accepted sessions open to consume capacity;
7. verifies the configured concurrency ceiling;
8. closes the synthetic sessions.

Because the seeded business disables missed-call SMS, abandonment cleanup remains internal to the load database.

```bash
DOTENV_CONFIG_PATH=.env.voice-load \
VOICE_RELAY_CLIENTS=50 \
VOICE_RELAY_CONNECT_CONCURRENCY=5 \
VOICE_RELAY_EXPECT_ACCEPTED=25 \
npm run perf:voice:relay
```

Expected:

```text
requestedClients: 50
accepted: 25
expectedAccepted: 25
rejectedByServer: 25
harnessFailures: 0
```

Keep connection concurrency at 5 initially because CallBackIQ separately limits pending websocket handshakes per IP; accepted sessions remain open while the harness creates later sessions.

## 9. Integrated Voice AI turn load

This adds real `prompt` frames and therefore exercises the production VoiceAgent path. It does not place PSTN calls, but it can consume OpenAI tokens. The synthetic business has booking disabled and fallback SMS disabled.

Start small:

```bash
DOTENV_CONFIG_PATH=.env.voice-load \
VOICE_LOAD_ALLOW_AI=true \
VOICE_RELAY_CLIENTS=3 \
VOICE_RELAY_EXPECT_ACCEPTED=3 \
VOICE_RELAY_TURNS=2 \
npm run perf:voice:relay:ai
```

Then:

```bash
DOTENV_CONFIG_PATH=.env.voice-load \
VOICE_LOAD_ALLOW_AI=true \
VOICE_RELAY_CLIENTS=10 \
VOICE_RELAY_EXPECT_ACCEPTED=10 \
VOICE_RELAY_TURNS=3 \
npm run perf:voice:relay:ai
```

The harness hard-stops above 10 AI clients unless you explicitly set `VOICE_LOAD_ALLOW_HIGH_AI=true`.

Watch p95/p99 AI-turn latency, turn failures, API memory/CPU, Mongo latency, and OpenAI rate-limit/error logs.

## 10. Existing real Twilio smoke test

The current repository already contains `scripts/verify-phase9-live.js`. Use it only after the synthetic tests pass.

Preflight only:

```bash
node --env-file=.env scripts/verify-phase9-live.js
```

Real calls:

```bash
node --env-file=.env scripts/verify-phase9-live.js --place-calls
```

That script makes a small fixed set of real Twilio calls for transfer, safety and service-path validation. It is not the load generator.

## Recommended progression

Run in this order:

```text
1. perf:voice:transport         100 -> 500 clients
2. perf:voice:webhook           100 -> 500 requests
3. perf:voice:capacity          50 attempts / 25 max
4. perf:voice:relay             50 attempts / 25 accepted
5. perf:voice:relay:ai          3 -> 10 simultaneous AI sessions
6. verify-phase9-live.js        real-call smoke test only
```

Do not move to the next stage until the prior stage has zero harness failures and expected capacity/routing behavior.

## Cleanup

The cleanest cleanup is to drop the dedicated `callbackiq_voice_load` database after testing. Do not run a destructive cleanup command against your normal development or production database.

If you use MongoDB Compass, select only the dedicated load-test database and drop it there. Re-run `voice-load:seed` before the next test cycle.
