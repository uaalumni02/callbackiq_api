# Provider balances

This additive update places funding and bill balances above the monthly expense table in Admin → Expenses. It does not modify subscription actions, provider webhooks, AI requests, booking, account access or customer expense allocations. It makes no provider POST requests and does not buy credit, move funds, charge cards or pay invoices.

## Sources and meaning

| Provider | Automatic source | What the balance means |
| --- | --- | --- |
| Twilio | Account Balance API using existing authorized Twilio reporting credentials | Current USD account credit. Subaccount spending shares main-account funds; do not add subaccount balances together. |
| Stripe | Live Balance API | USD funds available for payout and pending funds, displayed separately. Neither is prepaid service credit or your bank balance. |
| OpenAI | Manual dated entry with a billing-page link | Credit remaining as verified in the provider billing page. The connected OpenAI Costs API supplies spending, not this balance. |
| ngrok | Manual dated entry with a provider-console link | Enter the unpaid invoice amount, or choose prepaid credit if applicable to your account. The subscription price is not automatically an unpaid bill. |
| Hosting / Other | Manual dated entry | Enter a verified amount due, prepaid credit or payout funds with a statement reference. “Other” is a single summary entry, not an integration with every vendor. |

All six categories have a card, including explicit unavailable states. USD is supported. Automatic non-USD balances are flagged for provider verification instead of silently converted or mis-scaled. Stripe pending funds never get added to available funds. Different types of balances are never summed into a misleading company total.

## Setup

Apply and build both repos, then restart the API and reporting workers. The existing embedded worker, general worker or worker-lifecycle launches an independent balance timer. Existing `ADMIN_REPORTING_ENABLED=false` also disables this timer. No new dependencies or indexes are required; dedicated keys use the existing AdminReportingState collection and its `_id` index.

Twilio uses `TWILIO_COST_ACCOUNT_SID` or `TWILIO_ACCOUNT_SID`, and your existing API-key pair or account auth token. Use the account whose funds you want to monitor. Stripe optionally accepts server-only `STRIPE_REPORTING_SECRET_KEY` for balance reads, otherwise it uses `STRIPE_SECRET_KEY`. Only live keys are used for automatic balances. A separate restricted live reporting key can read balances while core application billing remains in test mode. Grant only the required balance-read access. This optional key does not change the existing monthly fee sync or core Stripe client.

OpenAI's existing `OPENAI_ADMIN_KEY` continues to supply cost reporting; adding it does not enable prepaid-balance access. Open the provider billing link, verify the balance and record it in the corresponding card. The same workflow handles ngrok, hosting and other bills.

For a one-time immediate read-only balance sync:

```sh
cd "$HOME/Documents/callbackiq_api"
node --env-file=.env scripts/sync-provider-balances.mjs
```

The command logs connection/progress and safe error codes, never credentials or raw provider errors. Provider HTTP requests time out after 10 seconds without retries; database connection selection times out after 10 seconds. Missing credentials are shown explicitly. A failure retains the last successful balance. Dashboard summaries may take up to 60 seconds to reflect the latest saved result.

## Freshness and manual entries

Automatic balance refreshes are scheduled approximately every 15 minutes, independently of six-hour expense reconciliation. Refresh balances queues a balance-only refresh. Sync provider costs continues to refresh expenses and also queues balances. A shared lease prevents repeated UI refreshes from bypassing an active automatic balance sync.

Each card shows the balance source and verification time. Automatic snapshots older than 30 minutes, or with a failed latest attempt, need verification. Manual entries older than seven days need verification. Current does not mean instantaneous: check provider billing before time-critical funding decisions.

Record balance opens an accessible form with a balance type, signed USD amount, verification time, statement reference, and optional payment due time or pending payout amount. Prepaid records include a low-credit threshold. The default automatic low-credit threshold is $10. Negative payout balances and overdue positive bills have separate alerts.

A manual entry replaces the *displayed balance only*. It cannot change expenses, subscription status or provider funds. A manual snapshot never silently decreases as expense usage accumulates: deposits, credits, payments and expirations may be missing. Remove manual entry restores the latest automatic snapshot if one exists, otherwise the card becomes unavailable. Removing a manual entry also removes that entry's custom threshold.

## API and audit

- `PUT /admin/balances`: validated manual snapshot. Required provider, kind, amountCents, ISO asOf no later than now, and reference. Optional pendingCents, dueAt and thresholdCents. USD only.
- `DELETE /admin/balances/:provider/manual`: remove the displayed manual override.
- `POST /admin/balances/refresh`: queue read-only automatic balance synchronization, rate-limited.
- `GET /admin/dashboard`: adds `founder.companyExpenses.balances`; all existing expense fields remain.

All routes use existing authentication and the shared database-backed admin check. Manual saves, removals and refresh requests are audited. Responses contain explicit reporting fields and do not expose credentials or internal owner identifiers.

## Validation and rollback

28 API tests pass across admin reporting routes, balance rules/persistence and existing expense normalizations. All 127 frontend tests across 45 suites pass. Both production builds pass. Required-index manifest still matches 289 declarations. Desktop and mobile fixture previews verify card contrast, the editing form and no document-level horizontal overflow.

Provider tests cover zero/missing/negative balances, separation of available/pending funds, test-mode rejection, unsupported currency, stale manual records, overdue bills, retention on failed sync, isolation from expense records, audit writes and active leases. No live balance credentials or production database were available for validation, so the preview uses explicitly synthetic data.

Restore the previous API and frontend together using the package installer's checked backup. No operational database rollback is required: only isolated reporting state was added. Stop reporting with `ADMIN_REPORTING_ENABLED=false` if necessary before restoring.

Sources:
- https://www.twilio.com/en-us/blog/developers/tutorials/product/check-twilio-account-balance-javascript
- https://www.twilio.com/docs/iam/api/subaccounts
- https://docs.stripe.com/api/balance/balance_retrieve
- https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs
- https://help.openai.com/en/articles/8264644
