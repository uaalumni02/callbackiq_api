# MeekCall API

## Run

Use Node 24.19 or newer within Node 24, MongoDB with replica-set support, and Redis for distributed workers and Socket.IO. Copy `.env.example` to `.env`, set the local values, then run `npm ci` and `npm run start:dev`. Use isolated accounts and synthetic tenants for provider testing.

Production builds use `npm run build`. Run `node build/server.js` with `PROCESS_ROLE=api` and `node build/worker.js` from the same commit with the configured worker roles. Set the public API and frontend origins, database and Redis connections, signed webhook secrets, billing configuration, and mail credentials in the host secret store. Keep a backed-up, stable `INTEGRATION_ENCRYPTION_KEY` for provider credentials and admin MFA. The startup validator owns required settings. `config/environment-inventory.json` lists the exact environment names and consumers.

## Test

Run `npm run verify` on a clean commit. CI runs the same command under Node 24. The plan in `config/check-plan.json` lists the blocking checks and advisory reports. The runner uses isolated MongoDB and inert provider credentials, writes results under `.verification/`, and checks coverage, build output, and source drift. Use `npm run verify -- --base <reviewed-base-sha>` when verifying changes against a specific base.

Runtime dependency advisories block. Full-tree development advisories are reported with the owner and expiry in `config/development-advisories.json`. Secret history and dependency review also run in GitHub.

## Release

The API repository owns the **MeekCall paired release** workflow. Set the API repository secret `CALLBACKIQ_CROSS_REPO_READ_TOKEN` to a credential with read-only Contents access to `callbackiq_frontend`. A release control commit pins the two full commit SHAs in `release.json`. A commit cannot include its own hash, so the manifest follows the API code commit it pins. Deploy the pinned API commit, not the manifest commit.

The workflow checks out the pins, runs `npm run verify` in both repositories, and runs the customer and staff browser suite against the exact pair. Apply the additive index migration and lead workflow backfill against the intended database with the following command.

```sh
node scripts/migrate-required-indexes.mjs --apply
```

The same command with `--check` is read-only and fails if an index is missing or conflicting, or a historical lead lacks current workflow fields. Applying again leaves completed projections alone. For an interrupted backfill, `--apply --after <last-reported-lead-id>` can resume. The final check still looks for gaps anywhere. Resolve index conflicts with an explicit reviewed migration. The command never drops indexes.

Deploy the pinned API and workers from the same SHA, then the pinned frontend. Confirm the release by running that same workflow with **Confirm the deployed pair** enabled. Configure `MEEKCALL_RELEASE_API_URL` and `MEEKCALL_RELEASE_FRONTEND_URL` as workflow variables and `MEEKCALL_RELEASE_MONGO_URL` as a database credential that can read the leads and inspect indexes. The job verifies the API's `/version`, the frontend build stamp, and release data readiness. API liveness and readiness remain at `/api/health/live` and `/api/health/ready`.

For rollback, use the last verified API/frontend pair and keep API and workers on the same version. Preserve additive indexes, notification receipts, and provider operation IDs. Check readiness, signed webhook delivery, and a synthetic customer-to-appointment journey with provider test accounts before onboarding customers. Offline verification works with stubbed providers.

## Architecture contracts

- Tenant scope comes from authenticated server context. Owner repositories enforce tenant predicates. Admin writes require a current authenticated admin and fresh MFA where required. Separate intervention actions own assignment, acknowledgement, and resolution. The ordinary alert edit only changes read state.
- Booking transition commands own durable appointment writes. Provider handoff, a MongoDB hold, and durable confirmation have distinct meanings. Cancellation and reschedule claim the observed appointment state before provider actions. Notification dispatch, projection repair, and compensation preserve operation identity.
- Lead workflow writes from Alert, Appointment, CallLog, Conversation, Lead, and Message refresh affected leads' Inbox flags and track inbound activity. The projection uses the triggering operation's session. Projection errors roll back the caller's transaction when one is active. Outside transactions the error is logged and the committed write result is preserved.
- SMS and voice use shared request policies. Provider ingress is authenticated, effects are deduplicated, and purpose-built workers own retries and recovery. Use the request lifecycle policies and read-model contracts to change customer-visible state.
- Keep the executable contracts under `contracts/` and the enforcement inventory current. Generate the descriptive writer review on demand with `node scripts/review-state-writers.mjs`. Regenerate the primary writer inventory with `node scripts/state-writers.mjs --write` after reviewing any owner change. Review changes to generated types and required indexes in the same commit as the source.
