# ADR-002 — Conditional completion writes

Status: implemented for billing/trial and tracking-number completion paths; full release verification pending.

## Decision

An asynchronous operation may change only the state it observed. Use
`conditionalWrite({ model, identity, observed, update })`. Identity contains the
document ID and, for tenant-owned models, the business ID. The observed object
contains the decision inputs, not just an operation timestamp. Match all inputs
atomically and never upsert. Return `{ applied, current }`; a miss reloads the same
scoped identity. A caller must branch on `applied` before subsequent effects.

This is an internal persistence interface, not an HTTP query/update language.
Selectors and ownership updates are rejected. Omitted fields are matched as
missing; explicit null follows MongoDB null equality semantics.

## Current implementation and limits

`src/services/database/conditionalWrite.js` is exercised against real MongoDB by
`tests/integration/conditionalWrite.rootCause.test.js`. Trial expiry uses it.
Billing/trial completions, tracking-number lifecycle work, release/deletion receipts
and entitlement projections use it. The remaining recovery/AI hotspot migrations
are part of the later contract work; this candidate does not certify every async
writer in the repository.

Monotonic receipt facts observe their operation key and pending marker; they
never rewrite mutable entitlement fields. Initial child creation uses insertion
and a unique tenant key, not an upsert over a concurrent creator.

A successful compare-and-set does not make subsequent database writes, email, or
provider calls atomic. Cross-document projections need their own conditional
ownership or transactional intent. Do not treat `applied: true` as permission to
perform an indefinitely delayed external action against changed entitlement.

## Required completion criteria

Inventory asynchronous completion writes; record observations for each; add an
interleaving regression before migration. Test lost races, tenant mismatch,
deleted records, and duplicate completions. Persist external intents before
dispatch where an uncertain outcome must survive process failure.
