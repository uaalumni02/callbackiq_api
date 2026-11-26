
## H05 — FIXED

restore schema parity in required index manifest

Validation: H05-before fails as audited; check-manifest passes after regeneration.

## H06 — FIXED

validate every enabled pilot capability before startup

Validation: H06-before 2 failures; H06-after 2 tests pass.

## M01 — FIXED

repair identity and forwarding fixtures and pin local release pair

Validation: baseline-before 6 assertions fail; M01-targets 42 of 46 then M01-checkout 4 pass; production constraints retained.

## B04 — FIXED

gate customer voice SMS and AI at fresh provider boundaries

Validation: B04-H09-before reproduces inactive dispatch; B04-H09-after 12 pass; B04-policy 15 cases pass.

## B03 — FIXED

enforce plan-owned atomic provider budgets and fleet circuit breakers

Validation: B03-before reproduces owner override; B03-atomic-final 17 pass; B03-frontend 5 pass.

## B06 — FIXED

require verified provisioned service before paid PRO activation

Validation: checkout-before 5 failures; checkout-final-targets 11 pass; A2P pending is disclosed in Stripe Checkout.

## B07 — FIXED

retire legacy checkout links and enforce one verified open attempt

Validation: checkout-final-targets 13 pass; checkout-billing-final passes; canonical Stripe and restricted portal checks fail closed.

## H01 — FIXED

start fresh terminal checkout generations and reject unverifiable retries

Validation: H01-final 12 checkout scenarios pass including missing timestamps and the safe retry window.

## B01 — FIXED

route trade hazards deterministically in English and Spanish before AI

Validation: B01-before fails on audit matrix; B01-after 368 pass; B01-channels all 12 trades and 336 SMS/voice hazard paths pass with model unavailable.

## B05 — FIXED

share negation-aware withdrawal across voice SMS and request planning

Validation: B05-M02-before reproduces cancellation; B05-M02-after 10 pass; B05-M02-regression 122 pass.

## M02 — FIXED

keep negated cancellation from suppressing compound request facts

Validation: M02-final 10 intent cases pass; shared policy also covered by 122 existing regressions.

## B02 — FIXED

Recheck complete fresh Google availability at every booking write

Validation: B02-M04-before-valid-fixture fails; H10-disconnect 9 targeted tests pass including final write and shared epoch.

## M04 — FIXED

Bound and exhaust Google event pagination before accepting availability

Validation: Page-two conflict and cyclic pagination fail-closed regression tests pass.

## H10 — FIXED

Bound all Google calls and durably reconcile fenced disconnects

Validation: H10-disconnect 9 tests pass including stalled response bodies and durable revocation retry.

## H03 — DISABLED FOR PILOT

Enforce callback-only voice requests and disable legacy live transfer

Validation: H03-H08-before fails; H03-H08-final 2 pass; extension fields remain inert.

## H08 — DISABLED FOR PILOT

Force Jobber off including legacy flags and provider selection

Validation: H03-H08-final 2 pass; no Jobber routes added.

## H02 — FIXED

Unify saved staff recipients with fenced per-recipient delivery and saved-settings tests

Validation: H02-H11-final 6 integration tests pass; unknown outcomes never automatically resend.

## H11 — FIXED

Notify saved urgent SMS and email contacts for every critical safety alert

Validation: H02-H11-final critical worker path passes without legacy policy; inactive contacts excluded.

## M05 — FIXED

Page and lease independent staff SMS polling partitions with durable cursors

Validation: H02-H11-final bounded two-page rotation passes; no unbounded policy query.

## M03 — FIXED

Require screened keypad acceptance before marketing calls count as answered

Validation: M03-before reproduces voicemail loss; M03-after 6 pass.

## H04 — FIXED

Revoke grants and erase tenant children transactionally with anonymized financial receipts

Validation: H04-before reproduces retained children; H04-M06-final deletion 9 cases pass; uncertain external receipts preserved.

## M06 — FIXED

Schedule leased redaction reaping and deletion retries with durable task heartbeats

Validation: M06-final 2 pass including simultaneous instances and actual redaction/reaping.

## H04 — FIXED

release secondary numbers and block erasure on foreign ownership

Validation: final-erasure-verified: 11 tests pass, including secondary number receipts and ownership conflicts.

## H11 — FIXED

deliver initial critical alerts even after acknowledgement

Validation: final-critical-delivery: 45 tests pass across recipient policy and workers.

## B04 — FIXED

preserve known pre-dispatch failures and recheck queued state

Validation: final-provider-dispatch-boundary: 4 suites pass, including state change after atomic reservation.

## M01 — FIXED

align strict fixtures and extract policy boundaries without growing budgets

Validation: 45 opt-out, repeat-caller and feature fixture tests pass; Google, approval, voice and domain regression suites pass; complexity compared with starting commit.

## M01 — FIXED

name inert provider fixtures explicitly for strict secret scanning

Validation: synthetic credentials only; no scanner exemptions added.

## H05 — FIXED

verify index apply and check against a fresh replica set

Validation: accept-index-migration-2: missing indexes fail, apply succeeds, check succeeds, repeated apply creates nothing.

## M01 — FIXED

recycle certification workers within the memory budget

Validation: accept-api-certification-bounded: deterministic production certification passes with provider access blocked.

## H04 — FIXED

erase hashed tenant budgets while retaining aggregate fleet spend

Validation: H04-budget-before reproduces retained children; H04-budget-after: 5 suites and 22 tests pass including foreign-tenant preservation and unchanged fleet spend.

## M01 — FIXED

scope history allowlists to exact inert fixtures and public release hashes

Validation: full history scan first reported 6 confirmed test/hash false positives; initial global-list syntax was incompatible with the installed scanner; the subsequent rule-level fix and final scan below are authoritative.

## M01 — FIXED

support installed scanner and verify secret-policy canaries

Validation: Gitleaks 8.24.3 full history: 453 commits clean; five canaries verify exact synthetic values/hashes are allowed and other credentials remain detected.

## M01 — FIXED

ship reproducible narrow secret-policy canaries

Validation: accept-api-secret-canaries: five offline detection and allowlist cases pass.

## B04 — FIXED

deny inactive phone verification while preserving unused preparation

Validation: B04-verification-before: 5 reproduced failures; B04-verification-final: 78 tests pass, preserving preparation without AI/SMS service entitlement.

## M01 — FIXED

make scanner canaries deterministic and retain exact historical exceptions

Validation: complete history scan passes; six deterministic path/value canaries pass; prior ignore fingerprints preserved.

## B04 — FIXED

cover missing tenant, preparation reuse and fleet circuit denial

Validation: B04-verification-policy-final: 33 policy cases pass with no provider calls.

## B02 — FIXED

Reject malformed and contradictory calendar availability evidence

Validation: B02-malformed-evidence-certified: 6 suites pass; seven original malformed-evidence probes and secondary-calendar probe reproduced first.

## H02 — FIXED

Preserve settings revision after sending a saved notification test

Validation: H02-provider-boundaries-after: 4 suites and 34 tests pass; actual notification-test then settings-save reproduced 409 before fix.

## B03 — FIXED

Centralize immutable spend-record retention with the pilot budget policy

Validation: Atomic budget and provider boundary integration tests pass; retention cannot be shortened by an owner.

## M06 — FIXED

Verify maintenance worker retry and graceful drain using central lease timing

Validation: pilot-queue-worker-faults: 26 tests pass including leased worker timer lifecycle.

## B04 — FIXED

Exercise queued recovery and relay identity failure boundaries

Validation: pilot-queue-worker-faults: 3 suites and 26 tests pass; wrong tenant and provider identity never mutate sessions.

## B02 — FIXED

Keep fresh calendar snapshot responsibilities within the complexity budget

Validation: accept-api-supplemental-5: complete calendar evidence and actual sync invalidation regressions pass; complexity guard passes without increasing allowances.

## B07 — FIXED

Verify rejected and uncertain provider inventory and legacy checkout receipts

Validation: accept-api-supplemental-4 and 6: terminal, mismatched, unverified-expiry and timeout receipts fail closed; 175 final money regressions pass.

## H02 — FIXED

Propagate polling failures and verify saved-contact email and partition contracts

Validation: accept-api-supplemental-2 and 5: SMTP rejection, authenticated links, default partition and override denial pass; no customer content in emails.

## H10 — FIXED

Verify normal refresh and expired revocation lease recovery

Validation: accept-api-supplemental-2: generation fence permits a current refresh and rejects a stale one; bounded revocation sweep and receipt replay pass.

## B03 — FIXED

Verify actual voice settlement and abandoned reservations without duplicate refunds

Validation: accept-api-supplemental-4: real replica-set ledger and fleet counters settle once; conflicting replay and malformed charge contexts are denied.

## B04 — FIXED

Verify persisted inbound SMS dispatch after a queued payment-state change

Validation: accept-api-supplemental-3: queued past-due work creates zero outbound messages; serialized voice identity retains tenant-scoped locks.

## M01 — FIXED

Close final failure-path coverage and refresh source inventory

Validation: All discovered API suites pass; no skipped or waived assertions; critical coverage and changed-code guards retain their original thresholds; full Node hardening 274 pass.

## M01 — FIXED

Record the exact historical generated-canary scanner false positive

Validation: Complete all-ref history scan: 470 commits clean; six deterministic canaries still detect unknown credentials; no path-wide ignore was added.

## M01 — canonical Mac verification follow-up

The owner's full run passed 636 suites / 12,818 tests, overall coverage targets and the critical-file ratchet, then stopped at changed-code coverage. Seven new unit files add 73 cases; an exact-location V8-record deduplicator retains distinct zero-hit branches and all thresholds. The contextual follow-up also includes worker.js in canonical coverage and integrates the deduplicator into the changed-code reader. No production application source is changed.

Local verification: 73/73 isolated unit tests pass on Node 24.22.1 against the delivered modules with declared doubles. Full private-repository replay is pending on the owner's checkout. The supplied resume runner preserves the previous full evidence and enforces all original gates before continuing the remaining stages.
