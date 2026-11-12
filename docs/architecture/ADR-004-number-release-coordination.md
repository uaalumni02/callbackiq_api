# ADR-004 — Number release and provisioning coordination

Status: approved and implemented for the concurrency candidate; full gate pending.

The approved schema adds integer `Business.trackingNumber.revision` and a durable
`TrackingNumberReleaseIntent` collection. Missing legacy tracking state/revisions
are observed as missing and acquire a first revision without a backfill. Required
indexes are added only for the new collection; no existing collection index is
changed. No production migration has run.

Release, provisioning, verification, activation and business deletion share the
`tracking-number:<businessId>` operation boundary. Mutations compare the observed
SID, phone, status and revision. Nested stages reuse the business claim. A resumed
process must still own its lease token; lease expiry alone is never authority.

A versioned intent records the exact provider account/SID, observed revision,
authorization observation and claim generation before destructive dispatch.
Known purchased-but-unattached SIDs use the same durable release mechanism.
Unknown outcomes survive process death. Unresolved intents block provisioning.

Only a verified provider receipt or exact-SID absence can complete local release.
Uncertain dispatch never blindly repeats deletion. Reconciliation takes a new
claim and reads that exact SID. A queued row that became obsolete cannot plan a
release of the current replacement SID. A lost process cannot adopt a successor's
intent token to complete its older work.

Business deletion consumes the normalized release receipt, retains the business
on uncertainty/replacement, and transactionally deletes local records only while
its observed deletion/number/subscription state still matches. Durable intent
history survives deletion and is never TTL-deleted.

A database predicate cannot undo a Twilio deletion already accepted. If trial
entitlement changes during dispatch, retain a durable recovery-review obligation,
create a tenant-scoped operational alert, and avoid the old release email/date
completion. Retry recording the alert if that receipt fails. This is explicit
recovery, not an atomic Stripe/Twilio transaction or a guarantee of reclaiming the
original number. The test provider cannot establish live carrier recovery policy.

Contracts use real MongoDB, actual Twilio SDK request formation with an injected
transport, lost-claim interleavings, and an actual killed dispatcher process.
No live Stripe/Twilio credentials or provider mutations were used.
