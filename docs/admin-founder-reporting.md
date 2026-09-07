# Founder reporting and company expenses

This update adds an owner overview, a prioritized account action queue, paginated customer health, activity comparisons, trial cohorts, reporting metadata, and company expense reporting. Existing demo outreach, support, account access, billing actions, SMS, voice AI, and booking paths remain in place. Reports write to dedicated reporting collections and use provider GET requests. No operational webhook or AI prompt was changed.

## Rollout

1. Apply the API and frontend files together. Build and test both before releasing them.
2. Run `node scripts/migrate-admin-reporting-indexes.mjs` in the API repo with its normal server environment loaded. This only creates the new reporting indexes and three activity lookup indexes; it does not drop indexes or alter customer records.
3. Deploy the API and frontend in your normal process. Reporting starts with embedded workers, the general `worker` role, or `worker-lifecycle`. An API-only deployment needs one of those worker processes. Set `ADMIN_REPORTING_ENABLED=false` to stop background reporting without stopping core workers.
4. Optionally run `node scripts/refresh-admin-reporting.mjs` once to populate existing accounts immediately. Without it the worker builds reports in bounded batches. Provider costs synchronize independently.
5. Visit Admin → Expenses. Enter your ngrok plan, hosting and other recurring expenses. Enter an explicit zero if a category truly has no expense. Missing categories intentionally prevent a complete total.

No new npm packages or package-lock changes are required. Provider credentials stay on the server; none belong in frontend `REACT_APP_*` variables. These commands access the database selected by `MONGO_URL`; use the intended environment.

## Monthly expenses

| Provider | Source | Setup and scope |
| --- | --- | --- |
| Twilio | `totalprice` usage records, current and previous month | Existing Twilio credentials; optional `TWILIO_COST_ACCOUNT_SID`. Account total includes subaccounts, numbers and other Twilio charges. It does not sum overlapping usage categories. |
| OpenAI | Organization Costs API | `OPENAI_ADMIN_KEY` (organization admin key). Optional comma-separated `OPENAI_COST_PROJECT_IDS` to limit scope to CallBackIQ projects. A normal inference key alone cannot supply organization costs. |
| Stripe | Balance transaction fees, including standalone fee entries and fee credits | Existing live `STRIPE_SECRET_KEY` with read access. Test keys are not treated as live expense evidence. Fees are reported amounts, not a guessed percentage of revenue. |
| ngrok | Manual recurring monthly expense | Enter the actual plan amount and a statement reference; carry-forward months are estimates until reconciled. |
| Hosting / other | Manual monthly expense | Enter recurring infrastructure, monitoring, software or other company expenses. |

Automatic provider expenses refresh about every six hours and include completed UTC days. The Expenses tab shows provider scope, freshness, last successful amount, prior month, monthly budget and estimated month-end expense. Usage APIs can lag final bills. Provider failures retain the last successful amount and label it stale; unavailable is not zero. Forecasts extrapolate at least three completed days, count fixed monthly entries once, and remain unavailable when coverage is incomplete.

A manual provider entry **replaces** its automatic amount for the selected month. Re-saving replaces the same entry; it does not add a duplicate. Restore automatic reporting removes that month's manual override and disables the provider's recurring rule. Company account totals may include development/test spending. Company totals are displayed separately from per-customer allocations and must not be added together.

`node scripts/sync-company-expenses.mjs` forces a read-only provider reconciliation. Missing keys or access show safe error codes. No live credentials, invoices or production billing were available during development; provider adapters were verified using controlled responses.

## Metric definitions and limits

- **Paying businesses:** active, live Stripe-backed subscription with a positive paid invoice; trial, access state and complimentary service are separate concepts. USD reporting only. Monthly-normalized recurring prices handle standard monthly/annual quantities; unsupported pricing/discount data stays unknown.
- **MRR:** current normalized recurring subscription value under that paid-account policy. Delinquent MRR is separate from real overdue invoice balances. Scheduled cancellation is future MRR loss. Daily observations begin at rollout; prior-month change and canceled-account counts stay incomplete until matching history exists.
- **Cash and contribution:** cash is gross paid invoice amounts, including tax and before refunds. Contribution uses allocated paid recurring invoice amounts excluding tax and recorded direct customer costs through the same UTC cutoff. It is a management estimate before refunds and disputes, not accounting profit. Missing allocation periods/tax amounts or cost categories suppress margin.
- **Billing history scope:** reconciliation follows each business's canonical current Stripe subscription, up to 1,000 invoices per run. It does not silently infer reassigned or replaced legacy subscriptions. First-payment and conversion metrics describe that scope. Separately reconcile legacy subscriptions before treating these as lifetime customer acquisition metrics. `node scripts/sync-admin-billing.mjs` refreshes current-subscription history.
- **Trials:** active trials are separate from paying businesses. Conversion uses first observed successful subscription payment within 30 days of trial start and only fully observed, reconciled cohorts. Readiness and usable-service days are based on first observation, not invented historic timestamps. Recent cohort outcomes naturally mature over time.
- **Readiness:** reuse the existing mode-aware readiness service without persisting changes. An optional disabled channel is not automatically a fault. Report the actual blocker and observed age. Suspended account access is separate from Stripe state.
- **Activity:** 7/30/90 days with equal previous periods; queries bounded to 180 days and one business. Missed inbound calls include voicemail. Recovery numerator uses recovered calls from that same missed-call population. Lead replies require inbound messages; lead bookings require a confirmed noncanceled appointment. Counts appear beside percentages. Pending approvals are not confirmed bookings.
- **Customer outcomes:** recovery SMS delivered, all outbound messages delivered, replied/qualified leads, confirmed appointments, completed jobs and recorded job revenue are separate. Recovery-only delivery uses tagged `missed_call_recovery`/`voice_fallback` messages; older untagged deliveries remain in all-outbound totals. Completed-job revenue is summed from appointments once; estimated job value is not treated as collected revenue. Zero-valued legacy revenue fields do not prove revenue was recorded.
- **Synthetic data:** directly flagged fixtures, explicit load-test markers, reserved fictional NANP numbers and linked synthetic leads are excluded. A founder can exclude a whole test account in Reporting profile without deleting it. Generic real business names are not filtered heuristically.
- **Costs per business:** SMS, voice, AI, numbers, other provider charges, processing and support categories. Positive voice-ledger estimates are partial evidence only. Enter reconciled or estimated category totals with coverage dates and support minutes in account details. Missing segment counts use the existing one-segment fallback for usage indication; do not price that fallback as reconciled SMS cost. Account-wide provider costs are not automatically allocated to tenants.
- **Action queue:** paid blocked accounts, processing failures, billing anomalies, delivery errors, delinquency, expiring trials without value, cancellation, overdue support, inactivity and founder follow-up. Readiness age starts with reporting observation. A high-risk flag suggests investigation, not an automatic account or billing change.

## API and privacy changes

`GET /admin/dashboard` returns founder summaries plus the first requested customer page. `GET /admin/customers` paginates separately (default 25, maximum 100). Filters: `days`, `page`, `limit`, literal `search`, `attention`, `includeExcluded`. Browser refreshes are coalesced and summaries cached; raw activity is aggregated in the worker, not on every dashboard load.

Customer detail responses contain explicit business/owner fields and reporting metrics. Unused raw lead, call, conversation and message arrays are removed. Intentional customer-detail access and all edits remain audited. Routine dashboard refreshes no longer flood the audit log.

All admin routes use the shared database-backed admin middleware after `checkAuth`. The old route chain already refreshed roles from MongoDB, so this is consistency hardening rather than a claim of a newly closed stale-JWT vulnerability.

`PATCH /admin/customers/:businessId/subscription-status` now returns **410** with `DIRECT_SUBSCRIPTION_MUTATION_RETIRED` and performs no write. It had no frontend caller. Existing Stripe-backed billing and account-access routes remain available. Any private external caller of that obsolete endpoint must migrate to the supported billing workflow.

## Operations, verification and rollback

Reports are eventually consistent, usually within minutes; completeness and stale counts are visible. Workers use bounded batches, query deadlines and expiring leases. Manual expense refreshes cannot bypass an active sync lease. Large-account load still needs production measurement; synthetic tests are not a 1,000-business performance certification.

Validation includes database-backed authorization, privacy, pagination, synthetic exclusion, billing separation, reporting cost replacement and recurring-expense tests; provider pagination/currency/rounding tests; existing billing, voice, booking and authentication regressions; all frontend tests; and both production builds. A fixture-driven browser preview is used for desktop/mobile rendering. It does not connect to your production providers.

To roll back, stop reporting with `ADMIN_REPORTING_ENABLED=false`, restore the previous API and frontend versions together, and rebuild/redeploy. Reporting collections can remain; they are isolated from core collections. The supplied installer backs up changed files and supports checked restoration. It never deletes your operational database.

Provider references:
- https://www.twilio.com/docs/usage/api/usage-record
- https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs
- https://docs.stripe.com/api/balance_transactions/list
- https://docs.stripe.com/api/balance_transactions/object
