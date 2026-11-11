# MeekCall engineering

Node 24.19 or later in the 24.x line, npm 11, Python 3 for the remediation installer, and Docker Compose v2 for the optional local replica set. The production Node build and frontend Vite build remain separate deployables. `callbackiq_*` repository, environment aliases, existing provider resources and old public asset URLs are compatibility interfaces; changing them is not a display-name rebrand.

## Local startup

From the API checkout:

```sh
npm ci
docker compose -f deploy/local-compose.yml up -d --wait
cp .env.example .env
node -e 'console.log(require("node:crypto").randomBytes(48).toString("hex"))'
```

Paste the generated value into `.env` as `JWT_SECRET`. Run `npm run validate:env`, then `npm run start:dev`. Development uses Node's built-in file watcher and the declared Babel register dependency. It does not need a global nodemon. The local DB is a replica set for registration/trial transaction compatibility. Existing MongoDB users can supply an equivalent isolated database URL.

From the frontend checkout run `npm ci`, `cp .env.example .env.development.local`, then `npm start`. Open http://localhost:3001. Register an owner through the public registration page. Blank provider credentials deliberately do not fabricate paid access, trial activation or telecom readiness. Use the offline tests for those workflows, or separate Stripe/Twilio/OpenAI test accounts and a publicly reachable, signed webhook URL. Local UI startup does not certify those integrations.

`npm test -- --coverage` uses one recyclable Jest worker. Jest creates isolated MongoMemoryServer databases. Never set tests to a production DB. `MONGOMS_SYSTEM_BINARY` can select a compatible local mongod when downloads are blocked. On environments prohibiting Unix sockets, wrap mongod with `--nounixsocket`; this is an environment limitation, not a production configuration requirement.

## Domain ownership

Routes own middleware and transport wiring. Controller facades keep stable entry points; subdirectories own registration/session, billing checkout/reads/subscription commands/webhooks/admin, integration connection/settings/operations and conversation access/records/lifecycle. `context.js` contains shared dependencies and pure helpers, not another controller router.

`services/booking/recoveryIntake.service.js` sequences explicit capture, triage, qualification, coverage, scheduling and staff-review stages. `voice/voiceAgent.service.js` sequences voice turn stages. `voice/relay/connection.js` owns one connection's state; Admission, Transport, Timers, Turns, Input, Setup and Transcript own its lifecycle operations. Preserve the ordering and cancellation tests before changing these stages. The state is per connection, not shared across tenants.

SDK construction belongs in `integrations/providerClients.js`; feature modules retain their timeout and retry options. Stripe period interpretation belongs in `helpers/billing/stripeSubscriptionSnapshot.js`. Callable phone identity belongs in `helpers/phoneIdentity.js`; legacy lookup mode preserves old stored keys. Do not use legacy lookup normalization as permission to dial a number.

## Durable operations and failure recovery

- Stripe event claims have unique provider/event identity and a processing token. Only that claimant can complete/fail the record. Unfinished duplicates return 503 with Retry-After. Customer-level reconciliation uses a distributed lease and retrieves the canonical Stripe subscription/latest invoice.
- Trial notice records claim before calling the mailer. A durable receipt repairs a missing subscription timestamp on replay. Definitely unsent configuration/connection failures retry with a limit. Unknown acceptance and expired sending claims become `uncertain` and create a deduplicated alert. Check the email provider receipt before manual resend. Message-ID alone is not an exactly-once guarantee from SMTP.
- Administrative extensions reserve the lifetime allowance and fixed target before Stripe, reuse an idempotency key, and reconcile the grant audit after an interrupted response. Pending intents are retried by the lifecycle worker. A second different extension waits for reconciliation. Supply a new Idempotency-Key for an intentionally separate support decision.
- Appointment dispatch completion is conditional on the notification claim and an unchanged appointment snapshot. Provider SMS operations retain stable idempotency identity. A lost claim cannot blindly save an old document over a newer cancellation/schedule.
- Jobber getAppointment operations must return id, startAt, endAt and status (or declare externalIdPath/startAtPath/endAtPath/statusPath mapping). Missing or mismatched dates leave confirmation pending for review.
- Scheduling adapters declare availability authority and confirmation capability. A handoff request is not a confirmed appointment. Providers without a verified idempotent retry path retain ambiguous outcomes for review rather than repeat the mutation.

## Rollout

Apply the source package to both reviewed commits, install dependencies and run the complete verification script. Review the required-index manifest diff; use `node scripts/migrate-required-indexes.mjs --check-manifest`, then the documented index migration with `--apply` against the intended database during the release procedure. Do not drop indexes or reset existing collections. Build both deployables. Deploy API and workers from the same commit, then UI. Verify `/api/health/live`, `/api/health/ready`, signed webhook delivery and a synthetic customer-to-appointment flow with provider test accounts before onboarding customers.

Read `docs/CONFIGURATION.md` for the generated environment inventory and typed worker settings. Production requires configured providers and the existing encrypted-token/Redis/readiness checks. Render/Vercel and external account settings cannot be established by a source ZIP.

## Change checklist

Every tenant-linked create/update must validate foreign references against the authenticated business; PATCH DTOs reject Mongo operators and tenant moves. A populated reference is not proof of ownership. New async effects require durable intent, claim identity, bounded retries and a reconciliation/manual-review path. Add behavior tests for the failure that motivated the change, including lost acknowledgements and stale workers. Keep existing coverage thresholds and branch gates. Run lint, architecture checks, dependency audits, contract checks, build and the full tests at the exact release revision. A local green run does not substitute for production provider verification.

## Compatibility and historical tooling

Historical phase-named scripts remain runnable for earlier release investigation. New work uses the domain map and one verification command, not a new numbered phase script. Do not delete scripts referenced by CI or the release runbooks without replacing those callers. Source parity hashes are reviewed change alarms, not a ban on refactoring: update a specific hash only with behavior evidence for that change. Existing logo filenames, environment aliases, old provider IDs and support addresses remain stable until their replacements are independently verified.
