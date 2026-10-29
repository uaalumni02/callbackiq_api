# MeekCall Stage 2B — API CI and behavioral contracts

Audited main: `52509ab87128e2aaf93282825124d4df5a3cdd0e`. This patch fixes exactly two stale source-text Jest assertions and adds behavior-oriented regression checks. No production source code, database schema, endpoint, provider integration, billing, customer response or feature flag changes.

## Background verified on GitHub Actions
Run `40936510250` on the audited commit executed 10,520 Jest tests over 494 suites. The release certification job failed at two source-location assertions: (1) `tests/completion/phase0-2.contract.test.js` expects `VALID_TRANSITIONS` inside `appointment.service.js`; (2) `tests/unit/conversationOrchestrator.v2.contract.test.js` expects `AVAILABILITY_HINT` inside `bookingStateMachine.service.js`. Stage 2A moved those definitions into their domain policies. Unlike earlier blocked Actions runs, this run actually executed. The other API CI release job's preliminary gates passed. The fixture tests include negative transitions and semantic booking hints rather than just moving source regexes to a new file.

## Why this does NOT grant 9/10 maintainability
Stage 2B does not refactor appointment transactions, the DB facade, transport retries, or SMS/voice orchestration. The new report quantifies hotspots; its readings are not a proxy for independent responsibilities. Separate feature changes must use durable behavior parity tests and staging verification; the multi-repository system is not certified by green Jest alone.

## Regression evidence and gates
- `npm run test:maintainability:stage2b` — changed tests and added behavior matrix.
- `npm run test:maintainability:stage2` — earlier contracts.
- `npm run test:critical` — billing, SMS, A2P, auth boundaries.
- `npm run test:scheduling-production-hardening` — booking and voice.
- `npm run test:hardening` and `npm run build` — isolated hardening and production syntax.
- `npm run maintainability:check` — original size/dependency ratchet.
- `npm run maintainability:hotspots -- --json` — read-only metrics.
- **Before main**: run `npm run release:certify:ci` against isolated test credentials and a dedicated MongoDB test instance, or observe the exact feature commit passing full API CI after pushing to `development`. This full suite took ~67 minutes in the audited run; don't claim completion based on only the focused suites.

## Subsequent work to justify 9/10
1. Incrementally decompose appointment lifecycle while retaining the authoritative `Appointment` record and transactional/idempotency boundaries.
2. Move tenant-aware persistence behind repositories with stable `Db` facade adapters, tested against replica-set fixtures.
3. Keep SMS/voice decisions consistent, but use read-only shadow comparisons before promoting the recovery coordinator.
4. Extract remaining Appointments, Billing, and Conversations UI controllers, with end-to-end stale response, delivery and booking evidence tests.
5. Adopt an enforced linter, dependency-cycle and critical-contract checks; prune frozen overlays only after dependency scans.

Rollback: revert Stage 2B Git commit. No migrations or environment changes.
