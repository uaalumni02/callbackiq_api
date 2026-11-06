# ADR-001 (PROPOSED, NOT ACCEPTED) — Request lifecycle authority

**Status:** design draft. No implementation or rollout is included in this package.

## Context and decision under evaluation

MeekCall has parallel request representations: Lead facts, Conversation booking state/memory, Alert review, versioned RecoveryCase/RecoveryEvent and Appointment booking truth. A sixth independent state machine would make drift worse. Prefer evolving the existing coordinator into one versioned request aggregate, with the appointment collection remaining authoritative for booking truth throughout the migration.

## Constraints

- Preserve all existing HTTP, SMS/voice, Twilio, Stripe, Socket.IO, schema and UI contracts.
- Do not promote beyond the existing `MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS`, enable authoritative mode, or remove legacy authority without owner approval.
- During `legacy` and `shadow`, a new reducer may decide but may not send SMS, book or write overlapping state. A divergence record must not become a customer-visible action.
- Mongo transaction must atomically persist request version/intent/idempotency and durable outbox for actions that cross process/provider boundaries. A provider response alone is not durable confirmation.

## Suggested aggregate and state table (illustrative; mapping is NOT complete)

| State | Candidate event | Guard | Transition | Effect contract |
|---|---|---|---|---|
| `capturing` | `facts_received` | tenant/consent/idempotency, not terminal | `capturing` or `needs_review` | persist customer facts/event only |
| `needs_review` | `staff_accepts_scope` | assigned human takeover; service eligibility verified | `accepted` | persist audited staff decision |
| `accepted` | `appointment_hold_created` | verified service and slot, valid hold | `scheduling` | enqueue durable booking intent |
| `scheduling` | `booking_confirmed` | matching `Appointment.status=confirmed` and durable provider evidence | `booked` | project appointment truth, queue separate notices |
| `needs_review` | `staff_declines` | authorization and version match | `declined` | persist reason and review resolution |
| *any nonterminal* | `customer_cancels` | checked customer/request identity | *domain-specific* | notify/close only if authorized |

**Do not turn this table into executable code yet.** The mapping of legacy `offering_slots`, `awaiting_confirmation`, `pending_business_confirmation`, `human_takeover`, and the complete allowed transitions must be extracted from actual existing methods and verified by tests. One legacy state may map lossy; preserve details in typed substates rather than discarding evidence.

## Proposed domain interfaces

- `states.js`: enumerations only, with explicit version.
- `transitions.js`: a pure transition table, no database or provider imports.
- `decide.js`: `(aggregate, event, context) => {nextState, effects} | rejection`.
- `requestLifecycle.service.js`: tenant-scoped load, expected-version compare-and-set, Mongo transaction and outbox.
- `effects/`: idempotent ports for SMS/voice/scheduling/notification/analytics with reconciliation.
- `legacyProjectionAdapters`: map committed facts into existing UI/API read records until parity is proven.

## Rollout and rollback proposal

1. Characterize all legacy paths with Phase 2 contract tests and source-of-truth inventory.
2. Add a new flag with default `legacy` and `shadow` comparison, but keep it disabled until tests establish equivalence and no extra write/side effect.
3. Operate in shadow for selected existing pilot businesses; require divergence review and explicit owner signoff.
4. Switch only approved pilots to authoritative, monitor and reverse flag on any regression; retain dual reads and replayable outbox.
5. Do not remove legacy writers until stable behavior under injected failures, multiple workers and exactly-once request semantics is independently certified.

## Open decisions

- Which existing `RecoveryCase` fields are sufficient, and which require an explicit dual-read migration?
- How do multiple service requests in a single conversation map into separate aggregates without altering existing lead identity?
- How are request cancellations and reschedules versioned relative to a confirmed appointment?
- Which effects require global idempotency vs provider idempotency vs compensation?

**Disposition:** no new model, migration, flag or authority was applied by Phase 0–1 package.
