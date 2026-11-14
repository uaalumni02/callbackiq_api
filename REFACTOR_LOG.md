# MeekCall Remediation Log — API

> Historical preparation log. The unchecked stages and "Vite plan only" entry
> describe their original dates, not current implementation status. The frontend
> now uses Vite. See [current maintenance notes](docs/MAINTENANCE_20261114.md),
> [ENGINEERING](docs/ENGINEERING.md) and [CHECKS](docs/CHECKS.md).

## BLOCKED — NEEDS OWNER DECISION

- **Browser verification:** Both repositories are now public. The new browser workflow uses the built-in read-only `github.token` fallback; Playwright must still pass on the PRs. Do not reintroduce a mandatory PAT for public checkout.
- **Authority rollout:** Do not expand `MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS`, enable a replacement request authority, or remove legacy booking authority without an owner decision.
- **Environment evidence:** No production, staging, Twilio, Stripe, or MongoDB systems were accessed. Full npm tests/coverage and live browser evidence cannot be certified in the artifact-building environment (repository clones and dependency installation unavailable).

## Status checklist

- [x] Phase 0: inspect selected current HEADs, structural hotspots, architecture boundaries and CI failure logs (source inspection only)
- [ ] Phase 0: run full unit/integration/replica-set/browser tests three times; measure coverage/complexity with local repo
- [x] Phase 1a: prepare guarded workflow change and credential runbook
- [ ] Phase 1a: owner credential provision, PR review, green browser E2E on development
- [x] Phase 1b: prepare post-commit failure correction + fault-injection regression tests (NOT yet verified against complete suite)
- [ ] Phase 1b: install on isolated branch, baseline characterize pre-fix, pass CI + local tests, verify retry obligations
- [ ] Phase 1b: inventory and repair every other commit-then-side-effect path
- [ ] Phase 2: executable behavior contracts for SMS, voice, booking, billing, tenant isolation
- [ ] Phase 3: design and implement shadow lifecycle, no pilot expansion
- [ ] Phase 4: decompose orchestration behind behavior contracts
- [ ] Phase 5: extract industry policies without changing emergency semantics
- [ ] Phase 6: retire facades and large dependency bags without weakening checks
- [ ] Phase 7: UI feature separation with render contracts
- [ ] Phase 8: regression-gated complexity/dependency metrics
- [ ] Phase 9: frontend CRA-to-Vite plan only

## Baseline metrics (Phase 0; GitHub static inspection)

Audit commit: `e51679e1d65e851dda31806604b7cf649fb7f0fe`, identical for API main and development at inspected time.

| File | Approx. lines | Key concern |
|---|---:|---|
| `src/voice/conversationRelay.server.js` | 1,387 | Transport/session/dialog logic together |
| `src/services/booking/bookingStateMachine.service.js` | 1,210 | ~40 import declarations, ~68 conditional if statements |
| `src/services/messaging/inboundSmsJobProcessor.service.js` | 627 | Broad orchestration |
| `src/services/booking/recoveryIntake.service.js` | 604 | 31 imports, 120+ conditionals, industry-specific triage |
| `src/db/db.js` | 583 | Compatibility facade and generated trampolines |
| `src/services/scheduling/appointment.service.js` | 406 | Large factory dependency wiring |

**Measurement caveat:** file sizes and counts are static signals, not cyclomatic-complexity calculations or claims that each line is wrong. Run `npm run maintainability:hotspots` and the full existing baseline scripts locally before rating improvement.

## Entries

### 1 — 2026-11-05 — Phase 0 / Phase 1 package preparation

- Source-of-truth recheck: `src/services/scheduling/commands/confirm-1.js` calls scheduling provider, then `appointment.save()` with status confirmed, then reminder creation; a failure creating the remedial intervention propagates after the successful save. This is the authorized behavior correction.
- Existing verification: API CI and Security/scale checks passed at `e51679e1`, but browser workflow failed at *partner-repository checkout* before browser execution. Failure is not proof of broken browser behavior.
- Proposed patch: isolate nonessential post-commit work (lifecycle repair, review repair, notification/intervention, projections, socket events) and return committed success. Keep HTTP contract, provider validation/compensation, database schema, SMS wording, event names and contents unchanged.
- A narrow Jest fault-injection test is provided; cannot claim it passed in the real repository until local installation and execution.
- Existing architecture hash audit checks source-body parity for extracted `confirm`. The guarded installer updates only that precise hash to the new reviewed implementation, and the new behavioral test is the regression evidence. The source-parity guard remains active; neither coverage nor test thresholds are relaxed.
- **Remaining limitation:** existing intervention rows are durable *manual recovery evidence* when writes succeed. If both reminder scheduling and intervention persistence fail, this slice logs the failure and returns successful booking truth, but does **not** introduce an automatic durable retry outbox. That unresolved requirement must be addressed with separately characterized schema-safe worker integration. Do not describe Phase 1 as fully certified before that work.
- No commits or PRs were created by this ZIP. The user will apply/verify on isolated `refactor/` branches. Rollback backups are generated automatically by installer.

## Test changes ledger

- No existing tests removed, weakened, skipped, quarantined, or rewritten.
- Added `tests/unit/appointmentConfirmation.postCommitBoundary.test.js` covering successful committed booking under reminder/intervention/socket/projection failures, provider rejection, Mongo save failure/compensation, and replay.
- Added `hardening-tests/phase1-cross-repo-checkout.test.mjs` and `hardening-tests/phase1-confirmation-source-guard.test.mjs`.

## Risk & rollback

- Primary risk: behavior of the extracted confirmation method depends on factory wiring and other service callers; full Jest and integration/regression suites are mandatory before PR.
- Rollback uses `python3 install.py --repo "$HOME/Documents/callbackiq_api" --rollback <backup.zip>` from the same refactor branch and refuses if files have changed.
- Rollout remains **not approved** until both browser and transaction coverage are verified.

## Phase 1 supplemental review

### 2 — 2026-11-05 — Public repository checkout correction

- Current GitHub metadata confirms API and frontend are public. The earlier assumed mandatory private-repository read credential is no longer needed.
- The Phase 1 workflow's unconditional `MEEKCALL_CROSS_REPO_TOKEN` check caused both browser jobs to stop before Playwright. Restore the existing optional `CALLBACKIQ_CROSS_REPO_READ_TOKEN || github.token` checkout contract. Keep `persist-credentials: false`, read-only permissions, branch selection, commit manifests and the full browser test step.
- CI source architecture checks explicitly require that original token fallback. This change restores those contracts rather than editing/loosening their rules.
- **Test changes ledger:** the newly added browser-checkout structural test is revised to assert the public-repository credential fallback, read-only permissions, both checkout directories and the unchanged E2E execution step. No tests are removed or skipped.
- The separate PR Dependency Review failure occurred when both repos reported private; verify Dependency graph enabled and re-run in the public configuration. Security audits remain enabled.
- Changes are workflow/tests/docs/log only; no application runtime, coverage thresholds, routing, SMS wording, webhook or DB change. Full PR checks are still required before merge.
