# Stage 2A: strictly reviewed extraction (api)

Audited base: 2e81ebdb64f6306078cda1eff96535c7fd028ca0

Seven source files across the two repositories are targeted by Stage 2A. All existing function bodies are moved verbatim, and external exports and API endpoints are preserved. No data migration, env change, Twilio call, Stripe call, Redis change, schema change, feature activation, or deployment is performed by the installer.

## Scope
- Booking lexical rules -> bookingMessagePolicy.service.js
- Appointment transitions and claim keys -> appointmentStatePolicy.service.js
- Existing nonblocking side effect -> dependency-injected appointmentEffectAdapter.service.js
- DB projection strings -> dbProjectionFields.js (Db class and all methods still unchanged)
- Inbound SMS lead update projection -> inboundLeadProjection.service.js

## Tests / release gates
Run npm run maintainability:check, npm run test:maintainability:stage2, then npm run test:critical, npm run test:scheduling-production-hardening, npm run test:hardening, npm run test:integration, replica-set and worker crash suites. Run npm run build (frontend: REACT_APP_API_BASE_URL=/api CI=true npm run build), and git diff --check. If any fails, do not merge. These commands should use isolated, nonproduction test credentials.

## Limitations
This is a safe, incremental partial decomposition, not a 9/10 maintainability certificate. Substantial appointment lifecycle and database repository refactoring, durable SMS orchestration, React page decomposition, typed API contracts and cross-channel authority consolidation remain outstanding. Source-hash guard fails closed against unreviewed revisions. GitHub Actions must be investigated separately and is not certified by this package.

## Rollback
If uncommitted, use git restore on only tracked modified files and manually remove the created files shown by git status. Once committed, revert the Stage 2A commit. No database rollback is required.
