# CallBackIQ coordinated fleet release

Target: at least 1,001 distinct businesses, 350 active voice sessions, concurrent inbound SMS and authenticated dashboards. This release implements the controls, deployment definition, recovery, monitoring and acceptance tooling. Capacity is approved only after the exact deployed API/UI pair passes the attached acceptance process.

## Implemented behavior

- Exhausted SMS jobs with expired leases transition atomically to dead/manual review. Live leases and completed work are untouched. Competing sweepers cannot claim the same transition. The process does not resend potentially accepted provider operations.
- Dead SMS and durable missed-call recovery work obtain idempotent, action-required staff reviews, even when an earlier alert write failed.
- An independent operations worker repairs those reviews, monitors queues and fleet heartbeats, and dispatches PagerDuty Events API v2 incidents. Overdue high/critical alerts, email uncertainty/failure, and high/critical reviews without a deadline after five minutes reach operations. Pager acceptance never acknowledges a business review. Acknowledging/resolving the business review requests incident resolution. Durable keys, claims, revisions and retry budgets protect dispatch and UI publication; uncertainty is retried only through the provider's incident deduplication key.
- Owner email retains its separate SMTP uncertainty policy. No blind SMTP retry was introduced. Installing files does not enable either channel or send messages; deployment configuration does.
- The opt-in `SCALE_PROFILE=business-1000-voice-350` rejects incompatible role/Redis/notification/provider-budget/drain declarations at startup. Normal installations without the profile retain their configuration behavior.
- Fleet health includes stale/missing process roles, oldest active SMS/recovery age, failed operations dispatch, and notification uncertainty. `/api/admin/scale-health` requires existing admin authentication. Run `probe-scale-health.mjs --page` outside the application cluster to detect complete API/database outages; the in-cluster outbox cannot operate without its database.
- Lifecycle scanning has configurable bounded parallelism, persisted fairness, conversation leases and a draining stop. The template increases scan throughput while retaining one owner per conversation.
- The voice harness rejects unexpected session endings, incomplete turns, explicit fallback replies, latency breaches, missing setup confirmation and dips in active sessions. It waits for complete text frames rather than counting the initial acknowledgement.
- The mixed harness verifies each manifest token against `/businesses/mine`, connects 1,001 dashboards, coordinates the voice/SMS workload start, measures live concurrency, and audits persisted SMS jobs/replies for tenant identity, completion, duplicates, uncertainty and provider-acceptance latency.
- A recorded `providerAcceptedAt` is distinct from delivered/read. The audit does not claim handset delivery.
- The soak runner repeats twelve passing five-minute cohorts and records setup/drain gaps. This is 60 minutes of sustained mixed test intervals, not a claim of an uninterrupted hour with the same calls. Realistic call turnover and continuous live-provider soak remain required observations for sign-off.
- The browser acceptance script signs in normally against staging in Chromium and WebKit mobile viewports, without injecting auth or rewriting requests. Real phones remain part of acceptance.

## Deployment

Read `deploy/scale/RUNTIME_INPUTS.md`. Build an immutable API image from `deploy/scale/Dockerfile`, pair it with the tested frontend commit, and render the deployment. Mongo/Redis, DNS/TLS, ingress controller, provider quotas, verified destinations and a staffed paging schedule are external prerequisites. The template does not configure your current hosting provider or provision those services.

Initial topology: 4 API, 6 voice, 12 SMS, 2 operations, and 2 of each other worker role. Voice has nominal N-1 headroom: five remaining replicas offer 500 session slots and 375 active-turn slots against a 350-call target. Fleet caps are 450 sessions and 400 AI turns. This is arithmetic headroom, not measured capacity. An abruptly lost voice pod loses its established WebSockets; remaining pods accept new calls, while fallback/recovery handles affected calls.

The renderer prints a Mongo connection allocation including one surge per deployment plus operator reserve. Ensure your managed service supports that allocation and measured I/O before deployment. Check actual query plans for queue claims, global alert scans, active queue age and high-history tenant reads. All new indexes are additive; run the existing migration before traffic.

## Local and CI verification

`test:scale-fleet` runs fast behavior and acceptance-contract tests. `test:scale-fleet:persistence` performs real Mongo claims, competing sweepers, a child process SIGKILL after the final SMS claim, and concurrent incident dispatch. `test:voice-concurrency` now includes 1,001 businesses and 350 concurrent production voice contexts in an isolated Mongo database; no live calls are placed by that suite.

The API CI workflow requires both new tiers before release certification. Existing release/coverage/security gates remain intact. If GitHub jobs do not start because of billing/spending restrictions, fix that account setting and rerun; dependency-update runs are not release certification. The bundle's `verify-local.sh` preserves a failing exit status and stops at the first required failure.

## Staging load input

Create a private JSON array of at least 1,001 records:

```json
[{ "businessId": "Mongo ObjectId", "to": "+1AUTHORIZED_DESTINATION", "from": "+1AUTHORIZED_CALLER", "token": "OWNER_TOKEN" }]
```

Each business and destination must be distinct. Tokens are validated against authoritative ownership. Use dedicated staging businesses, eligible subscriptions, routing, configured services, SMS readiness and permitted test recipients. Do not buy 1,001 numbers merely to run a test: provider-simulated staging may use a controlled provider boundary, but label those results simulated and separately obtain real-provider quota/handset evidence. The harness does not create numbers or disable consent, subscription, anti-abuse, signature or tenant guards.

A controlled mixed run generates roughly 60,000 inbound SMS events and 7,000 AI turns per five-minute cohort, plus replies. Set representative test budgets and provider limits deliberately. A production per-customer communication cap may correctly block this synthetic workload; do not disable it globally to make the test pass. Use isolated test tenant limits, and test normal production guard behavior separately. A missing or suppressed expected reply fails the baseline audit.

Required environment includes `SCALE_API_URL`, `VOICE_LOAD_HTTP_TARGET`, existing voice signature/WebSocket settings, `TWILIO_AUTH_TOKEN`, `MONGO_URL` for read-only outcome verification, `SCALE_TENANTS_FILE`, `SCALE_ADMIN_TOKEN`, `SCALE_API_SHA`, and `SCALE_UI_SHA`. Keep secrets in a private environment file, not command history or committed reports. Set the server's existing synthetic relay mode only in the dedicated staging deployment so its setup marker is available. Do not enable load-test shortcuts in production.

```bash
DOTENV_CONFIG_PATH=.env.scale-staging SCALE_ALLOW_STAGING_LOAD=true npm run perf:mixed-scale
DOTENV_CONFIG_PATH=.env.scale-staging SCALE_ALLOW_STAGING_LOAD=true npm run perf:mixed-soak
```

Baseline gates: 350 active sessions, 20 completed turns per session, voice p95 <=5s/p99 <=10s, webhook p95 <=500ms/p99 <=1s, dashboard p95 <=1s, provider-acceptance p95 <=10s, at least 95% of requested 200 ingress requests/second achieved, zero missing/duplicate/wrong-tenant/uncertain outcomes. These thresholds are explicit initial acceptance targets. Do not relax them after a failure without reviewing the product requirement.

Raw identity files contain only generated SMS IDs and business IDs, but still keep reports private. Outcome auditing uses bounded reads against the staging database, follows coalesced jobs to their primary reply, and allows a bounded queue-drain interval. A stalled child/report/audit must fail rather than yield a partial certificate.

## Failure and live acceptance matrix

Perform these with synthetic staging customers and record observedAt, observedBy and an evidence reference. No script injects production faults.

| Exercise | Required observation |
| --- | --- |
| 350-call arrival burst | All expected sessions admitted; meaningful response latency meets the target |
| Kill SMS worker on final claim | Expired exhausted work becomes one actionable review, never an unexplained duplicate reply |
| Graceful voice termination | Readiness removed, no new admission, existing calls drain within actual host grace |
| Abrupt voice failure | Loss is bounded to the failed process; affected calls have documented fallback/recovery; no cross-session contamination |
| Redis outage | Explicit coordination policy holds; no fleet cap overshoot; recovery after restoration |
| Mongo failover | No double booking, duplicate charge or cross-tenant record; queue resumes or produces actionable review |
| Provider 429 / timeout | Bounded retries; distinguish rejected, accepted and uncertain operations; no blind duplicate side effect |
| Webhook replays | Same logical operation remains idempotent across workers and restarts |
| Tenant isolation | Foreign API IDs, cookies, tokens and Socket.IO rooms denied; correct owner retains access |
| Email and operations paging | Real recipient receipt and escalation schedule verified, including timeout and downtime |
| No staff response | Review remains unacknowledged; operations receives the page; customer receives no invented callback promise |
| Real handset journey | Voice, missed-call SMS, reply, transfer/busy/no-answer and opt-out work through actual providers |
| Booking and billing | Approval, calendar write, confirmation, reminder, reschedule/cancel, trial and expired access agree |
| Mobile authentication | Real iPhone and Android sign-in, menus, urgent review and appointment actions work |
| Backup restore | Restore isolated replica set; verify key records and replay identities before approving recovery time |
| Ingress | Real signed HTTP and WebSocket traffic survives host/path/protocol forwarding and intended timeout |
| Quotas and continuous soak | Validate actual provider budgets, normal call turnover and a sustained live period, not just repeated cohorts |

Copy `deploy/scale/acceptance.example.json` to a private `scale-evidence/acceptance.json`, fill actual observations, and reference the measured mixed reports. Run `npm run verify:scale-certificate`. This validator checks recorded evidence; a human must verify references and live observations. Never fill blank observations with assumed success.

## Operations and rollback

Run an authenticated external probe every minute from outside the cluster. Alert on unavailable health, SMS queue age >60s, recovery age >30s, missing worker groups, and failed paging. Repeated mail uncertainty is visible in the snapshot and requires review. Include provider dashboards and Redis/Mongo service monitoring because a completely failed application cannot report its own health.

Use existing owner acknowledgement/resolution actions to close customer reviews. Pager receipt alone is not resolution. Inspect the provider before any manual customer resend. For failed pager dispatch after 20 tries, repair routing credentials and investigate the persisted OpsIncident; retry the same dedup identity after explicit operator review.

Keep the prior image and paired frontend build. Stop new voice admission and drain before rollout/rollback. Retain compatible SMS and operations workers until their queues are handled. Preserve completed job/provider identities and additive indexes. Rolling back source cannot undo messages, pages, appointments, charges or migrations.

References: PagerDuty Events API v2 at https://developer.pagerduty.com/ and Kubernetes workload lifecycle at https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/ .

The certificate requires a separately observed `continuousLiveSoak`: maintain at least 350 active live sessions with call turnover for one uninterrupted hour while SMS and dashboard activity continue. Repeated mixed-load cohort reports do not satisfy this observation, and duplicate report run IDs are rejected.
