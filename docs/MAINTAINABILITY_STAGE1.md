# MeekCall maintainability, safe stage 1

Reviewed revision: a452c6bd7eb37fb3e0d661c1edd34c4e2767dcb3

This patch only extracts existing synchronous functions / presentation code, and adds tests, a size/overlay ratchet, and documentation. It does not change API routes, booking confirmation, SMS/voice responses, stored schemas, migrations, feature flags, Twilio, Stripe, Redis, provider configuration, authentication or deployment settings. The old public booking selector export is preserved.

Interim module owners:
- API: bookingStateMachine = legacy booking orchestration; offeredSlotSelection = pure offer choice; appointment.service = actual appointment lifecycle; recoveryCoordinator = separate pilot-only staff review (NOT universal authority); inboundSmsJobProcessor = SMS transport; urgencyPolicy = pure urgency preservation; voice/ = voice transport.
- Frontend: pages = routing and UI; conversationPresentation = conversation formatting/exports; conversationIntelligenceModel = response normalization; appointmentPageModel = appointment view selectors.

Run npm run maintainability:check and the new unit tests first. Then run the existing comprehensive suites, API build, UI build, and production-representative staging tests (billing, approvals, tenant isolation, duplicate webhooks, provider errors, voice/SMS continuity, idempotency and worker crashes). Disable live side-effect tests unless explicitly using sandbox credentials. GitHub CI cannot be treated as green until executed on these exact commits.

This is NOT a 9/10 maintainability certificate. Remaining high-risk work requires separate reviewed change sets and verified behavior parity: authoritative cross-channel workflow, deeper repository abstractions, full large component decomposition, validated versioned API contracts, lint/type enforcement and toolchain modernization. Promoting the recovery coordinator to replace legacy decisions would be functional change and is intentionally excluded.

Rollback: revert the commit produced after applying this patch. No database rollback or environment change is needed.
