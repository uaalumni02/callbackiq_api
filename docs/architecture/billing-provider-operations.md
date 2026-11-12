# Billing operation receipts

`requestTrialExtension` owns the provider command and validates its outcome.
Business code supplies subscription identity, target end date and an idempotency
identity. The adapter translates Stripe seconds/period fields into domain Dates.
Only a matching trial status and end date produce a verified receipt; a returned
foreign subscription identity cannot verify the operation. Missing SDK setup,
provider rejection, uncertain transport and an unverified receipt have distinct
outcomes. The shared error translation retains the original transport cause for
diagnostics while business code receives a stable code and outcome.

A real Stripe SDK connected to a local HTTP fixture characterizes the exact
request path/body/idempotency header before and after the seam. Real MongoDB
contracts retain the lost-acknowledgement intent and reconcile it using the same
idempotency key without granting extra days. No live provider calls are made.

Scope: this operation and the existing normalized phone release/inspection ports
are implemented. The other direct Stripe and Twilio business-service calls in
`provider-direct-call-census.txt` have not all been migrated. This document does
not close API-A-02 or certify the complete root cause.
