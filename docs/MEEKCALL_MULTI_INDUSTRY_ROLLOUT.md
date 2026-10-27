# MeekCall multi-industry guarded rollout

This change broadens available business categories without renaming existing stored values. New industry choices are not certifications for regulated workflows. Healthcare, legal, and financial workflows require independent privacy, authorization, and compliance review.

## Opt-in flags (leave disabled until staged and reviewed)

- `MEEKCALL_REQUIRE_INDEPENDENT_TWILIO_FALLBACK=true`: refuse same-origin fallback configuration. First deploy an independently hosted, independently monitored voice fallback and durable SMS intake fallback, and verify per-business destinations without relying on the primary API or MongoDB. A different hostname alone does not prove independence.
- `MEEKCALL_CONCISE_MISSED_CALL_PROMPT=true`: shorter general-purpose voice copy. The queued state does not promise SMS acceptance or delivery.
- `STAFF_NOTIFICATION_CRITICAL_OVERNIGHT_ENABLED=true`: *only* opted-in critical staff SMS may bypass the application send window. Does not override A2P/opt-out protections. Verify law, recipient preference, and campaign compatibility before enabling.

## Acceptance outstanding

1. Provision a separate Twilio Function/TwiML endpoint with verified fallback business phone and voicemail; avoid forwarding loops. Check number mappings and Twilio console configuration.
2. Provide an independent durable SMS fallback with validated Twilio signature, idempotent replay, and audit receipts. Never acknowledge successfully if not durably persisted.
3. Live real-carrier voice/SMS/landline/VoIP tests; failures under API/DB/Redis outage; on-call consent and acknowledgment tests; call forwarding proof.
4. Industry-specific conversation evaluations including safety vs urgent business requests, shared SMS/voice context, unverified promises and privacy.
5. Retain old business types, customer opt-outs, usage limits, leases, queueing, business isolation and booking safety. Do not automatically merge to `main` without successful regression tests.

This is an incremental compatibility release, not a claim that every industry is ready for paid service or that independent fallback is deployed.
