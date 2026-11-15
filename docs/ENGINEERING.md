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

Use `npm run check` while editing and `npm run check:release -- --base <comparison-commit>` on a clean committed candidate. [CHECKS.md](CHECKS.md) defines the canonical profiles, pinned child runtime, inert provider environment, retained legacy aliases and exact evidence limits. The release coverage step uses one recyclable Jest worker. Jest creates isolated MongoMemoryServer databases. Never set tests to a production DB. `MONGOMS_SYSTEM_BINARY` can select a compatible local mongod when downloads are blocked. On environments prohibiting Unix sockets, wrap mongod with `--nounixsocket`; this is an environment limitation, not a production configuration requirement.

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

## Reschedule ownership

`src/services/scheduling/reschedule/command.js` composes `createRescheduleCommand`.
`prepare.js` performs validation, identity/replay lookup and availability reads;
it never creates a hold. `finalize.js` owns hold reservation, receipt staging,
provider-link release and durable confirmation/lineage writes. `providerHandoff.js`
is the only calendar mutation. `followUp.js` repairs projections, creates missing
notification jobs and updates the lead. Its reschedule lifecycle repair uses
`repairMissingOnly` so repeated follow-up preserves sent delivery receipts.
Inputs/results are documented in `reschedule/types.js` and each phase's JSDoc.
Phase dependencies are injected; transitive imports into infrastructure are
forbidden by the import audit. The old `commands/reschedule-1.js` export remains
an import-compatibility facade, while production composition uses the new name.

A replacement finalizes only while its held status, original lineage and staged
provider receipt still match its observed claim. Existing document sessions,
validators and save hooks are preserved. Error recovery reads durable confirmation
before restoring pending state and never demotes a possible confirmation when
that read is unavailable. Pending restoration is itself conditional on a held
replacement. This corrects the characterized lost-finalization acknowledgement
case: same-key replay now repairs the confirmed replacement rather than returning
an orphaned hold. Normal route and response contracts are unchanged. The separate
legacy behavior of a concurrent cancellation of the original remains pinned;
this extraction does not claim to correct every original-appointment race.

Run `npx jest --runInBand rescheduleBoundaries.characterization reschedulePhases.contract`
on every change to these phases, plus related scheduling tests. The six original
characterization cases are frozen; their SHA-256 is recorded in the maintenance
report. The original first run demonstrated the failed replay before extraction.
The reviewed source-parity record now protects the new composition callback,
with the explicitly permitted phase imports; behavioral contracts protect the
replacement phases. Complexity exceptions for the retired 427-line method and
432-line factory are removed rather than transferred to the new modules.

## State-writer registration and request persistence

`contracts/state-writers.json` is the generated, reviewed inventory of durable
record mutations and conservative writer candidates. `scripts/state-writers.mjs`
uses the AST, resolves model/document aliases, and records each owner, authority,
command, exact predicate, guard evidence and local projection/repair references.
Full document saves, caller-bound tenant records and extracted write capabilities
are included conservatively. Empty guard/repair evidence is an explicit review
item; registration is not a correctness certificate or a whole-program dynamic
JavaScript proof.

`npm run contracts:state-writers` runs inside both canonical profiles. A new
writer, a changed owning function/import binding, or a retired entry left behind
fails the check. `npm run contracts:state-writers:generate` refreshes reviewed
changes, but cannot register a newly introduced raw writer outside the transition
layer. New domain code must call an approved transition command. The negative
tests plant real source changes and assert that both the checker and regeneration
reject an unregistered/bypassing writer. Existing registered domain commands keep
their documented boundaries; this is a source enforcement path, not a runtime
permission system for MongoDB.

`requestBookingPersistence.service.js` owns booking decision filters, document
saves and lease/turn fencing. `bookingTurnState.repository.js` is a compatibility
export. Intake, request revision, withdrawal, eligibility and staff-review stages
use its persistence commands and shared guard policy; they keep pure fact changes
and existing observable ordering. The intake persist closure now belongs to this
layer rather than the orchestration stage. Document-attached sessions, validators
and save hooks remain intact.

`requestStateTransaction.service.js` owns request-review MongoDB transactions,
session binding, retry-attempt isolation and the final lease fence. Staff workflow
commands receive no MongoDB session. `requestStateRead` and `requestStateWrite`
bind their work to the current attempt. An idempotent replay that returns before
writing retains the previous no-final-fence behavior. The stale-intake hold claim,
retirement and review/projection writes belong to
`intakeHoldTransition.repository.js`; the review service only requests that
transition. Appointment-to-conversation projection inherits the owning transaction
without requiring the caller to pass a session.

Run `npx jest --runInBand requestBookingPersistence.characterization requestStateTransaction.contract rescheduleBoundaries.characterization reschedulePhases.contract`
on every change to this layer, plus the related booking/intake/staff workflow
suites. The baseline request-booking characterization is frozen. For shared
persistence changes, include the complete booking-related test folder selection,
then run the full canonical check at the end of the part.
