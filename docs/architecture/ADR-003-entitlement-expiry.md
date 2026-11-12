# ADR-003 — Entitlement and trial-expiry ownership

Status: implemented for the concurrency candidate; full release verification pending.

Subscription is the persisted entitlement authority. Access calculation stays in
`subscriptionAccess.service.js`. HTTP reads and lifecycle workers share
`expireObservedTrial`; controllers cannot implement a second expiry transition.

Expiry observes the tenant, status, trial end, canonical Stripe subscription,
release date and document version. A lost observation reloads the same scoped
subscription. A rejected expiry sends no expiry notice and does not project its
old access state. Stripe refreshes, checkout completions, cancellation and trial
extension receipts follow the same conditional-write rule.

Business setup and cost-control fields are projections. `projectCurrentEntitlement`
reloads Subscription inside a transaction and conditionally advances its version
before updating Business. This prevents a read-only transaction snapshot from
committing an old projection after a newer entitlement update. Business.isActive
remains an account/suspension flag. Projection never toggles it for billing.

Production/staging trial redemption and Business projection require transaction-
capable MongoDB. Trial redemption's existing compensated standalone fallback is
retained only for local/test use. No trial length, grace period, price, access
policy or customer email copy is changed.

A verified extension grant is immutable evidence. Marking its matching pending
intent applied is a monotonic receipt fact. That completion observes the intent
key and pending status; it does not overwrite current entitlement fields.

Persistence contracts cover conversion/extension during expiry and provider
refresh, transactional projection conflicts, checkout completion during conversion,
invoice/payment-method/cancellation races, extension receipt reconciliation,
and replica-set duplicate trial redemption. See the rootCause/contract tests in
`tests/integration` and `tests/unit/subscriptionProjection.contract.test.js`.

Trial redemption and the entitlement projection both require transactions.
Every environment rejects an unsupported standalone MongoDB transaction with
`TRIAL_TRANSACTION_REQUIRED` (503) before consuming a redemption or changing a
subscription. There is no compensating standalone fallback: it could consume
one side of the grant before the entitlement projection failed. Local development
uses the documented replica set. The standalone persistence regression exercises
all four runtime modes; the replica-set concurrency contracts verify successful
activation and duplicate rejection.
