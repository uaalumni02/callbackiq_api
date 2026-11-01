# Stage 3 — boundaries and preserved behavior

This release extracts appointment attribution and deterministic booking response creation with source-exact function bodies. The original named API export `resolveAppointmentAttribution` remains, including the original asynchronous lookups, tenant filtering, fallback priority, and result shape. All other scheduling lifecycle and orchestration remain unchanged. New Jest tests prove a focused subset of contracts, while the existing large suites remain mandatory.

Architecture check: `npm run maintainability:boundaries`; tests: `npm run test:maintainability:stage3`. The CI job enforces the new check. Limitations: this does not consolidate the recovery coordinator, booking state machine, SMS processor and appointment service or prove runtime correctness.
