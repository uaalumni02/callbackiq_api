# CallBackIQ scale and security hardening

This change prepares the application for a measured rollout. It does not certify a capacity of 1,000 businesses or 300 real calls. Deploy to staging first. No infrastructure, credentials, production data, GitHub branches, or production releases were changed by this work.

## Implemented

- Existing dashboard sockets expire with their JWT and are revalidated in batches every 15 seconds (configurable 1–60 seconds). User password/session-version/role changes and business ownership/activation changes request immediate cluster-wide disconnection through the Redis adapter. Database revalidation failure disconnects affected sockets. Direct database changes and bulk writes are covered by periodic revalidation, not immediate hooks.
- Standalone workers initialize a headless Socket.IO publisher. Redis connection, command and shutdown waits are bounded. Optional cache reads fall back; required coordination has an explicit failure policy. Readiness rejects draining instances and loss of required Socket.IO Redis connections.
- Voice gets process-level pending, active-session and AI-turn limits, optional Redis fleet limits, a dedicated `voice` process role, and graceful draining. Overflow remains subject to the existing voice fallback handling; verify your configured forwarding/SMS/voicemail behavior end to end in staging. A failed upgrade alone is not a guarantee that a caller reaches voicemail.
- Recovery SMS and missed-call follow-up intents are durably inserted before webhook completion. The SMS worker processes them using deterministic tenant/event keys, leases, retry budgets and dead-job alerts. Existing outbound provider idempotency remains authoritative. A provider-uncertain operation must be reviewed rather than blindly resent. Completed intent identities are retained to prevent replay resurrection.
- Cookie-authenticated mutations require the origin guard even when an arbitrary Bearer header is present. Staging receives production protections. Cookie SameSite is configurable. Production validation rejects insecure signature/CSRF bypass flags and disabling durable recovery.
- Native bcrypt preserves existing bcrypt password hashes and moves hashing off the JavaScript thread. AI qualification uses the hardened classifier, validates types/caps, handles JSON fences, and records unverified extraction provenance. Legacy conversation analysis uses a bounded history. Model output remains untrusted; prompt separation is not a complete injection defense.
- Webhook rate limits use atomic Redis counters when configured. Required indexes have an additive migration and checked manifest; existing index semantics are verified, including uniqueness, TTL and partial filters. No automatic index dropping is introduced.
- Frontend requests have bounded total deadlines; safe reads can retry one 429 with Retry-After and jitter. Mutations are not automatically retried. Realtime refresh has a maximum debounce delay and reconnect resynchronization.
- Production legacy logging passes through a redacting adapter. Runtime metrics expose event-loop latency and local voice capacity. Production build now emits loadable ES modules matching the repository's module type.

## Deliberate compatibility choices

The review did not support adding stale auth caches, replacing the existing queue with BullMQ, imposing an arbitrary Mongo instance size, or rewriting React Scripts as prerequisites. HTTP authentication still reads authoritative revocation state. Existing owner metrics are already date-bounded; PDF imports and active SMS history were already bounded/lazy. Large-page refactoring, queue replacement and index removal should follow measured query and throughput evidence. Redis failure policy and limits need deployment configuration, not assumptions based on instance count.

## Staging topology and configuration

Use a Mongo replica set, managed Redis, at least two API instances, a separate voice instance group, and independent workers. Mongo sizing and pool totals must be measured across all processes. Use the same Redis namespace/channel prefix across API and worker instances of this deployment and distinct prefixes for other environments.

| Process | Command after `npm ci && npm run build` | Configuration |
| --- | --- | --- |
| API, two or more | `node build/server.js` | `PROCESS_ROLE=api`, `VOICE_RELAY_ENABLED=false`, `API_INSTANCE_COUNT=2` or actual count |
| Voice, scale independently | `node build/server.js` | `PROCESS_ROLE=voice`, `VOICE_RELAY_ENABLED=true` |
| SMS, initially two or more | `node build/worker.js` | `PROCESS_ROLE=worker-sms`; includes durable recovery jobs |
| Automation | `node build/worker.js` | `PROCESS_ROLE=worker-automation` |
| Lifecycle | `node build/worker.js` | `PROCESS_ROLE=worker-lifecycle` |
| A2P | `node build/worker.js` | `PROCESS_ROLE=worker-a2p` |
| Maintenance | `node build/worker.js` | `PROCESS_ROLE=worker-maintenance` |
| Voice usage reconciliation | `node build/worker.js` | `PROCESS_ROLE=worker-voice-usage` |

For separated processes set `SOCKET_REDIS_REQUIRED=true` everywhere, plus `REDIS_URL` or purpose-specific `SOCKET_REDIS_URL`, `RATE_LIMIT_REDIS_URL`, `VOICE_CAPACITY_REDIS_URL`. Set `COMMUNICATION_ROUTE_RATE_LIMIT_FAIL_CLOSED=true` for distributed webhook enforcement; this intentionally returns retriable errors during coordination failure. Optional cache failure can still use the database. Redis ACLs must permit the adapter and Lua coordination commands. Set `RUNTIME_METRICS_LOG_ENABLED=true`.

Default local voice limits are 100 sessions including pending admissions, 100 pending, and 50 concurrent AI turns. Explicitly tune `VOICE_INSTANCE_MAX_SESSIONS`, `VOICE_INSTANCE_MAX_PENDING`, and `VOICE_INSTANCE_MAX_AI_TURNS` from measurements. Optional `VOICE_FLEET_MAX_SESSIONS` and `VOICE_FLEET_MAX_AI_TURNS` protect provider-wide limits across the fleet; configure both in a multi-instance rollout. Capacity keys have leases exceeding the application's 10-minute maximum call duration. Do not raise call duration independently of those leases. Leave room for one instance draining or failing: nominal aggregate capacity equal to 300 is not enough to preserve 300 calls during a rollout.

Route `/ws/voice` and voice/tracking HTTP webhook paths to the voice group. Route dashboard/API and SMS webhooks to the API group. Preserve externally signed URLs, host, protocol, query string and form body. Explicitly list trusted proxy IPs (`VOICE_TRUST_PROXY_HEADERS=true`, `VOICE_TRUSTED_PROXY_IPS`); do not trust arbitrary forwarded headers. Preserve the current HTTP proxy configuration for your ingress. Keep Socket.IO polling session affinity if polling remains enabled; the Redis adapter does not replace affinity. Configure WebSocket idle and total timeouts for call duration.

Health/readiness: preserve the existing liveness endpoint; use the ready endpoint for traffic eligibility. Send SIGTERM, remove readiness, then allow existing voice sessions to finish. Default `VOICE_DRAIN_TIMEOUT_MS=610000`, `WORKER_DRAIN_TIMEOUT_MS=120000`. Allow at least 13 minutes termination grace if embedded workers are used; separate voice and SMS workers are preferable. A platform that kills processes after 30 seconds cannot provide this drain behavior. Test actual ingress and orchestrator connection handling.

Set `NODE_ENV=production` (or the supported staging configuration). Keep signature validation and CSRF origin checks on. Set `AUTH_COOKIE_SAME_SITE=lax` only after verifying your app/API are same-site HTTPS domains and login flows work; otherwise retain the compatible `none` + Secure configuration and origin guard. Do not raise SMS processing concurrency until provider rate limits, whole-job duration, Mongo pool utilization and queue age have been measured.

## Ordered rollout

1. Retain the previous release artifact and take the normal database backup. Review the changes on a branch.
2. Install with `npm ci` on the actual deployment OS/architecture so native bcrypt is available. Build both projects.
3. Against a staging database, run the existing provider/production migrations required by your release, then `npm run verify:index-manifest`, `npm run migrate:required-indexes -- --apply`, and `npm run migrate:required-indexes`. The apply operation creates only missing indexes; conflicts stop the gate and require an explicit reviewed migration. Never run `syncIndexes()` blindly. Index builds can consume substantial I/O, so schedule them before traffic ramp-up.
4. Run the full existing release certification plus the added gates below. Do not accept known baseline failures without resolving or separately dispositioning them.
5. Start Redis-enabled workers before rolling API/voice. Keep recovery workers running while any API version can enqueue durable jobs. Verify a recovery intent produces one provider operation, a persisted message, live UI updates, and a completed job. Exercise provider timeout and worker termination before acceptance and after acceptance.
6. Canary one API/voice instance, exercise login/reset/revocation, signed calls, SMS, opt-out, booking, billing and tenant isolation; then ramp traffic. Confirm no stale sockets survive the 15-second revalidation window plus bounded read time.
7. Run the sustained mixed-load test and failure exercises. Review database explain plans for hot tenant/date queries, index usage, memory, event-loop p99, active/rejected voice counts, provider quotas, and SMS queue oldest age.

Rollback: stop admitting new voice sessions and drain. Roll back UI/API only after queued recovery intents have completed or have been assigned to compatible retained workers. Do not stop all durable workers and silently abandon queued work. Additive indexes and optional fields can remain; do not drop them during rollback. Older versions restore the security gaps this change addresses. Preserve dead/uncertain work for reconciliation; do not bulk requeue it without reviewing provider state.

## Acceptance commands

API:

```sh
npm ci
npm run build
npm run verify:index-manifest
npm run test:scale-readiness
npm run test:durable-persistence
npm run release:certify:ci
SCALE_TEST_REDIS_URL=redis://127.0.0.1:6379 npm run verify:realtime-cluster
```

Use an isolated Redis for that cluster fixture, or set `SCALE_TEST_REDIS_BIN` to a locally installed redis-server path. It launches two processes and verifies worker-style publication and revocation through a real adapter; it does not replace authenticated tenant-isolation tests.

Frontend:

```sh
npm ci
CI=true npm test -- --watchAll=false --runInBand
npm run build
```

For the provider-backed mixed test, prepare at least 1,001 provisioned staging businesses and a private JSON array of `{ "businessId": "...", "to": "+1...", "from": "+1...", "token": "..." }`. Each `to` and business must be distinct and tokens must belong to those tenants. Use test-controlled destination numbers, provider configuration and authorized accounts. Never commit this credential file. This test can send messages and incur AI/provider costs.

Set `SCALE_TENANTS_FILE`, `SCALE_API_URL`, `VOICE_LOAD_HTTP_TARGET`, `VOICE_LOAD_WS_TARGET`, the matching signature URLs, `TWILIO_AUTH_TOKEN` and required existing voice harness settings. Then explicitly opt in with `SCALE_ALLOW_STAGING_LOAD=true npm run perf:mixed-scale`. The runner requests 300 simultaneous AI relays, 200 signed unique SMS webhooks/second, and at least 1,001 authenticated dashboards over five minutes. It refuses a run with fewer than 1,001 connected dashboards; the voice report records actual open relays before turns. It is an acceptance driver, not a result from this workspace.

Initial targets: webhook ack p95 <500 ms / p99 <1 s; dashboard p95 <1 s; ordinary SMS provider acceptance p95 <10 s; no unexplained missing work or duplicate provider effects. Inspect child reports and server metrics: the mixed runner checks dashboard latency and child exit status, not every server-side SLO. Repeat with deliberate webhook replays, a 300-message burst, Redis/Mongo/provider outages, SIGTERM during calls, killed SMS workers, password resets and cross-tenant attempts. Measure queue age and provider acceptance independently of fast webhook acknowledgements. Verify fallback routing under both instance and fleet saturation. A successful five-minute run is not a soak test; follow it with a sustained run matched to realistic call durations and token usage.

## Verification performed here

- API production build succeeds and the compiled app imports as ES modules.
- Frontend: 43 suites, 118 tests passed; production build succeeds.
- New focused API tests: 19 passed (session expiry/revocation, durable identity and fencing calls, admission/drain accounting, Redis deadline, AI validation, indexes, proxy, hash compatibility).
- Additional focused API regressions: 8 suites, 53 tests passed.
- Real Redis with two Socket.IO processes: cross-process event delivery and room revocation passed.
- Local WebSocket transport run: 1,001 synthetic sessions, 3,003 simulated turns, 301 peak open connections, zero failures, approximately 25 seconds. Database and AI were simulated; this is not evidence of provider-backed capacity or 1,001 real tenants.
- Broad API unit run: 1,952 passed, 24 failed. Comparison against the original commit reproduced 23 failures (six existing assertions and 17 Mongo-dependent tests blocked by the runtime). The remaining failure was the intentionally tightened cookie+Bearer CSRF behavior; its updated test passes. The whole release gate is not green.
- MongoMemoryServer cannot initialize here (`open: Operation not permitted`). Real database persistence/concurrency gates, including the newly added durable-job test, require CI or staging. They are not represented as passed.
- Existing repository hygiene check reports clean for the tracked files. Complete secret-history scanning remains unverified. Run a full-history redacted gitleaks scan of both repositories in CI and rotate any confirmed exposed credential through your secret manager. Do not interpret dependency/hygiene results as proof of no historical secrets.

Source bases: API `3c1adbe73416dfd0428ca833a541d526f6b536fe`; UI `f8f3d61db750a0abd0da1f559a1349b29c9df71f`. A GitHub connector recheck returned 404, so this work makes no claim that remote main still equals these locally available commits.
