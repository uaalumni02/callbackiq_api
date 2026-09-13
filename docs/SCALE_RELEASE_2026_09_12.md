# Scale readiness update — September 12, 2026

This is an implementation update, not a capacity certificate. Do not advertise support for 1,000 businesses or 300 concurrent calls until the deployment passes the acceptance workload and live-provider checks below.

## Included changes

- Leads, calls and conversations expose continuation controls. Search reaches the API across pages. Visible summary cards explicitly describe loaded records, not an all-history total. Existing overview endpoints remain available for all-history lead/call aggregates.
- Messages open with the latest 100 in chronological display order; earlier pages can be loaded. Exports contain loaded history and the screen discloses this. Existing API clients retain oldest-first ordering unless they request `order=latest`.
- Direct links can retrieve a lead or conversation outside the initial page. No fallback to a different customer's conversation is introduced.
- CORS exposes cursor headers; the common API helper preserves existing response data while exposing pagination metadata. Overlapping page requests discard stale results and deduplicate records by ID.
- Lifecycle candidates are ordered by persisted last-scan time, updated under the existing conversation lease, including no-ops. One failed item no longer aborts the rest of the batch. The worker reloads the candidate under its lease. Existing takeover-expiry policy is preserved.
- A durable staff-email outbox covers unresolved high/critical reviews: one initial notice and one overdue notice. An already overdue review first discovered by the worker receives the overdue notice only. Verified owner email is resolved from authoritative business ownership at dispatch. Customer message contents and contact details are omitted from email.
- Unique alert/stage identities, atomic claims, bounded SMTP waits, capped retries for known pre-acceptance failures, and explicit uncertain states prevent blind re-sends. SMTP acceptance is not proof of inbox delivery or staff acknowledgment. A crash after beginning a send requires review; this design does not claim exactly-once SMTP delivery.
- Email processing runs separately from the lifecycle scan, with three dispatch lanes per process and independent database claims. Existing `worker-sms`, `worker`, and embedded `all` roles start it through the SMS lifecycle worker. `worker-lifecycle` runs trial/admin lifecycle work; it does not run SMS lifecycle work.
- Optional bounded AI-turn waiting absorbs short capacity bursts, supports cancellation and retains fallback at the queue bound/deadline. Existing immediate-rejection behavior remains the default until staging configuration explicitly enables waiting. Active session caps are unchanged.
- Joi and Nodemailer were updated with the lockfile. API and frontend runtime dependency audits found zero vulnerabilities at validation time. Nodemailer moves to major version 10; validate the actual configured email transport before enabling notices.
- Browser CI supports a narrowly scoped cross-repository read token and optional pinned counterpart ref. Frontend CodeQL now has Actions read permission. Neither change installs credentials or reruns remote workflows.

## Local verification

Run the bundled verify-local.sh. It installs locked dependencies, runs the existing API release gate, the new persistence/dispatch/queue tests, API build and runtime audit, frontend suite, frontend build and runtime audit. It stops at the first failure; do not push a failing release.

Validation performed in the build workspace:
- Frontend: 49 suites / 147 tests passed, including page continuation, earlier messages and deep-link isolation.
- Targeted API: 8 suites / 46 tests passed; notification dispatch and lifecycle schema: 2 suites / 9 tests passed.
- Both production builds passed; index manifest regenerated and checked.
- Database-backed regression suite could not execute: MongoDB exited with `open: Operation not permitted` before tests could run. The six persistence tests are included and mandatory in API CI; they are not represented as passed.
- Full API release certification and browser customer/staff workflow were not run successfully here because they require MongoDB. No live provider calls, messages, purchases, production writes, deployments or GitHub pushes were made.

## Required deployment actions

1. Keep the existing release available, back up the database and run the full local/CI gates against the exact API/UI pair. The installer refuses to overwrite a modified target file; do not bypass the guard if recent local fixes changed a file.
2. In staging first, run `npm run migrate:required-indexes -- --apply`, then `npm run migrate:required-indexes`. The migration is additive and does not drop indexes. New indexes cover scan fairness and the notification outbox. Never run it against production implicitly as part of installation.
3. Configure `STAFF_NOTIFICATION_EMAIL_ENABLED=true` only after confirming the existing `GMAIL_ADDRESS`, `GMAIL_PASSWORD`, HTTPS `CLIENT_URL`, and verified owner email. The feature is off by default to prevent unexpected messages on installation. Enabling it processes existing unresolved high/critical alerts, including backlog. Review that backlog first.
4. Verify initial and overdue email on a test owner, acknowledgment before sending, provider rejection, timeout and process interruption. Verify the Needs Attention status. Accepted means the mail server accepted it, not that staff read it. Failed/uncertain jobs require operator review; inspect provider records before any manual retry. There is no automatic SMS/pager fallback in this update. A staffed monitoring/escalation procedure is still required before unattended operation.
5. For short voice bursts, test `VOICE_TURN_QUEUE_WAIT_MS=1000` and `VOICE_TURN_QUEUE_MAX=100` in staging. Waiting is capped at five seconds regardless of configuration. Do not raise limits based solely on instance count. Measure local and fleet turn occupancy, queued turns, timeouts and meaningful response latency. The initial acknowledgment audio is not the full answer.
6. Set explicit local and fleet session/turn limits, shared Redis and namespaces, independent voice and SMS workers, and a measured Mongo connection budget. Choose and test rate-limit outage behavior explicitly; neither fail-open nor fail-closed guarantees successful webhook processing during an outage.
7. Verify host termination grace, ingress WebSocket behavior, readiness removal and routing. `npm run verify:scale-deployment` checks declared settings, not the actual hosting provider. `DEPLOY_TERMINATION_GRACE_MS` is a recorded assertion, not a host configuration mechanism. Extra instances absorb new work but do not migrate live WebSockets from a crashed instance.
8. Configure the optional GitHub secret `CALLBACKIQ_CROSS_REPO_READ_TOKEN` in each private repo with read access to only the counterpart repository. For a repeatable release pair, set `CALLBACKIQ_FRONTEND_REF` in API CI and `CALLBACKIQ_API_REF` in frontend CI to the tested counterpart commit. Fork PRs do not receive private secrets; do not use pull_request_target to expose credentials to untrusted code.

## Capacity acceptance

Use an isolated staging fleet and authorized test destinations. The existing `perf:mixed-scale` targets at least 1,001 distinct authenticated businesses, 300 AI relays and 200 signed SMS webhooks/second. Its default five-minute run is only a first gate. The separate voice certification script has its own smaller stages; invoking it does not automatically certify 300 calls.

Retain redacted JSON reports as protected CI artifacts with exact API/UI SHAs, topology, limits, duration and provider quota evidence. Do not commit tokens, tenant credential files, customer PII or provider secrets. Record:
- Actual simultaneous sessions and overlapping AI turns; full-turn p50/p95/p99 and failures/fallbacks.
- Dashboard latency and result correctness with older records and large histories.
- Webhook acknowledgment latency separately from queue age, provider acceptance, and handset delivery.
- Mongo claim/query plans and documents examined, pool wait, CPU/memory and event-loop lag.
- Independent SMS worker termination, Redis/Mongo/provider failure, replays, voice SIGTERM and abrupt process failure, no-response escalation and tenant isolation.

Run a sustained soak representative of your busiest expected hours and call durations. Define pass/fail thresholds before the run. Require zero cross-tenant exposure and zero unexplained missing work or duplicate business effects. Do not treat Mongo as a queue as a fixed jobs-per-minute ceiling; optimize its claim predicate only from explain plans and measured latency. Preserve replay identities when archiving completed jobs.

## Rollback

Stop new admissions and drain calls. Disable new staff email admissions and wait for sending jobs; inspect uncertain jobs. Retain or run a compatible worker for pending jobs before rolling back. The source installer can restore files it changed if they have not been edited since installation; it cannot undo database migrations, sent emails or deployments. Additive indexes and job identities should remain. Do not delete notification/recovery identities to make a retry happen.
