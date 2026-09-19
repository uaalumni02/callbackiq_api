# SMS Production Acceptance

CallBackIQ SMS is considered stable when the production acceptance gate passes. A single transcript should no longer trigger a bespoke architecture change unless it exposes a genuinely new failure class.

## Release-blocking invariants

1. No unverified appointment, dispatch, staff-callback, price, or availability commitment.
2. Known service, address, or preferred-time facts are not asked for again.
3. Unsupported work stops pricing/scheduling intake; staff-review work pauses pricing/scheduling until staff accepts the service.
4. Compound customer turns are answered as compound turns. Pricing plus scheduling cannot silently drop one intent.
5. Callback instructions remain visible without promising a response time.
6. Ambiguous output fails safely instead of guessing.
7. Repeated emergency language is deduplicated inside the customer-facing reply.
8. Existing confirmed appointments are not downgraded by the guard; confirmation evidence must come from booking state.

## Fixed acceptance corpus

`tests/fixtures/smsProductionAcceptanceMatrix.js` contains 120 representative cases spanning plumbing, HVAC, electrical, and roofing. The matrix intentionally stays between 75 and 150 cases. It complements the existing 300+ intent golden corpus; it does not replace it.

## Transcript-change rule

When a real conversation fails:

- If it is another example of an existing invariant class, add the transcript as a regression variant and fix the shared policy/invariant. Do not add a transcript-specific branch.
- If it exposes a new failure class, document the class, add representative cross-trade cases, then change the architecture.
- P0/P1 issues (unsafe commitments, lost state, unsupported-service scheduling, safety failures) block release.
- Wording preferences that preserve the invariants do not block a pilot by themselves.

## Commands

- `npm run verify:sms-production-acceptance`
- `npm run test:sms-production-acceptance`
- `npm run certify:sms-production`

The certification command verifies structure, runs the production SMS matrix and existing core SMS regression suites, then builds the API.
