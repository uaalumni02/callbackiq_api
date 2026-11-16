# Reschedule and state-writer maintenance report

Status: reschedule extraction and scoped request persistence migration implemented. Part 1 and Part 2 canonical checks passed. The single full release run passed 36/37 gates; its coverage failure was closed by five supplemental tests and a passing targeted coverage check. The complete profile was not repeated. The universal runtime writer migration remains partial, as detailed below.

## Scope and source

- Repository: `uaalumni02/callbackiq_api` only.
- Baseline: `3d706738cff51e27298dad6dff5e79da9b05b68f`.
- Branch: `maintenance/reschedule-and-state-writers`.
- Frozen recovery characterization commit: `5821b96fa740cfac44d12805c9bea4b1c1344c1f`.
- Reschedule extraction commit: `3fd10aa441f4189f683dfe8bfd8f9c29296db907`.
- Inventory/persistence baseline tests commit: `19aa9f5516e60a1fee33d555835ee4164aefd318`.
- Request persistence migration/code candidate: `b942bcb5db68889cd46ae38046bc57d87d0ecd2b`.
- No frontend, billing, voice, or A2P production source changes are included.

## Part 1 — explicit reschedule phases

The production entry point now composes `createRescheduleCommand` from `src/services/scheduling/reschedule/command.js`. Developers can inspect validation/replay, the provider operation, durable writes, and notification/projection effects independently:

| Module | Responsibility |
|---|---|
| `prepare.js` | Validate input and request identity; read the original/replacement and service; determine availability and replay behavior |
| `providerHandoff.js` | Perform the provider mutation and return a normalized provider receipt; no database writes |
| `finalize.js` | Reserve/link the hold, stage the receipt, release provider-event uniqueness, confirm the replacement under its held/lineage/receipt claim, and finalize original lineage |
| `followUp.js` | Repair projections, create missing notification jobs, and update lead linkage |
| `recovery.js` | Retain pending evidence, translate existing errors, and preserve a durably confirmed replacement after a lost acknowledgement |
| `types.js` | Document the narrow phase inputs and result types with JSDoc |

The prepare phase is read-only. Although hold preparation includes choosing the intended hold, the actual hold write belongs to `finalize.reserveReplacement`.

The old `commands/reschedule-1.js` path remains a two-line compatibility export for existing callers and frozen tests. Production composition and its getter use the new name. Other scheduling factories were not renamed.

### Developer benefit and removed responsibilities

A developer changing provider behavior can read `providerHandoff.js` without also reading notification scheduling, claim persistence, and error compensation. A developer changing durable confirmation can read `finalize.js` and its tests without reconstructing the provider SDK contract. The command orchestrator is 31 lines; no new reschedule function exceeds 60 lines. Each phase receives a named input/result object and explicit injected capabilities. The former 427-line method no longer owns all four concerns.

### Authorized recovery correction

The original six-test characterization was run before extraction. Three interruption/replay cases passed; the finalization case failed: MongoDB saved the original as rescheduled, the acknowledgement was lost, the catch path demoted the replacement to held, and a same-key replay returned that held replacement. A separate diagnostic hook captured this persisted state without changing the failing assertion.

After the user directed work to proceed, recovery was corrected to read durable confirmation before restoring a pending snapshot. If the confirmation read is unavailable, recovery does not blindly demote a possible confirmation. Pending restoration is conditional on the replacement still being held. A staged legacy replacement reached through an already-rescheduled original can resume finalization. These are explicit recovery corrections, not a claim of bit-for-bit equivalence in every failure outcome.

Repeated reschedule follow-up now requests missing-only reminder repair, preserving sent receipts. The scheduler's unrelated default refresh behavior is unchanged.

### Behavior evidence

The frozen six-test suite is unchanged, SHA-256 `4e46a3b7179a118afbc6eb76b69a097556bcb671bec9b6d4ac056903ad664be1`. All six cases now pass, including interruption after hold creation, provider mutation, durable handoff, and original finalization. The tests check appointment uniqueness, provider event identity, lineage, conversation/lead projection and notification-job/receipt convergence.

Three added phase contracts verify stale replacement claims, repeated follow-up with sent receipts, and unavailable confirmation reads. The related scheduling/compatibility tests also pass.

| Verification | Result so far |
|---|---|
| Related tests selected from changed files | 124 suites / 3,096 tests passed |
| Recovery and phase pins rerun by name | 2 suites / 9 tests passed |
| Selected scheduling, phase and compatibility contracts | 6 suites / 46 tests passed |
| Transitive boundary negative tests | Passed |
| Comprehensive architecture/source-parity guard | Passed; includes 314 tenant behavior contracts across 16 suites |
| Part 1 full canonical check | Passed all 8 steps; 565 ordinary suites / 11,585 tests; 729.98 seconds |

These are isolated tests with disposable MongoDB replica sets and synthetic provider boundaries. They do not certify live calendar or SMS-provider behavior.

### Line counts and budgets

| Item | Before | After |
|---|---:|---:|
| Legacy reschedule entry file | 433 lines | 2 lines (compatibility export) |
| Largest reschedule function | 427 lines | 31 lines |
| Reschedule method exception | 427 | Removed |
| Reschedule factory exception | 432 | Removed |
| API file exceptions | 35 | 34 |
| API function exceptions | 294 | 292 |

The seven new reschedule modules total 348 physical lines, plus the two-line compatibility export (350 versus the former 433). The benefit is explicit responsibility and dependency ownership, not merely a smaller entry file.

| New reschedule module | Lines | Largest function |
|---|---:|---:|
| command | 53 | 31 |
| prepare | 68 | 13 |
| providerHandoff | 25 | 18 |
| finalize | 80 | 18 |
| followUp | 23 | 18 |
| recovery | 65 | 21 |
| types | 34 | — |

The old source-parity record was reviewed and moved to the new composition callback. Its allowed phase imports are explicit and transitive infrastructure imports are forbidden. Structural compatibility assertions were updated to the actual new owner files. The frozen behavior tests were not edited or weakened. No complexity allowance was raised.

### Existing behavior retained

The original cancellation-race characterization remains unchanged: a concurrent cancellation of the original can still be overwritten by original-lineage reconciliation. The new conditional claim protects replacement finalization; this change does not claim to fix every original-appointment race. The baseline scheduler-default receipt-reset characterization also remains unchanged; missing-only behavior is selected specifically for reschedule follow-up. Both distinctions are visible in the frozen tests.

## Part 2 — state-writer audit and transition ownership

The AST inventory contains **439 writer sites/candidates**, including 412 existing registered domain sites and 27 transition-layer sites. It covers direct protected-field assignments, atomic mutations, document saves, aliases/chained queries, computed mutation dispatch, destructive removal, and extracted write capabilities. Each row identifies the authoritative record, permitted owner/command, exact source predicate when available, claim/lease evidence, projection/repair references, and writer/owner/import fingerprints.

The canonical check now rejects an unregistered writer, changed writer/owner/import, missing metadata, and stale registrations. Regeneration also rejects a newly introduced raw domain writer outside the central transition layer. The planted-writer test exercises the real scanner/checker and proves rejection; it does not merely inspect a fixture string.

### Developer benefit and removed responsibilities

- `requestBookingPersistence.service.js` owns document saving, decision predicates, conflict translation, voice/lease fencing, and the intake lead/conversation persistence sequence. Booking stages issue persistence commands instead of directly implementing saves and guard policies.
- `requestStateTransaction.service.js` owns MongoDB transaction lifetime, session binding and attempt isolation with AsyncLocalStorage. Domain request commands do not receive a session. Concurrent attempts cannot borrow another transaction's session. Existing explicit legacy sessions remain supported at the central appointment-projection boundary.
- `intakeHoldTransition.repository.js` owns stale-hold conditional retirement, booking projection and staff-review updates. The review service only requests the transition.
- Staff/intake, customer revision, withdrawal, and eligibility callers use the shared persistence boundary. The obsolete booking-turn repository is a two-line compatibility export.

A developer working on request-review behavior no longer needs to reconstruct MongoDB session propagation, document `$where` restoration, or the implementation of lease/voice checks across these callers. Caller-stage check timing is retained explicitly so this extraction does not silently alter failure behavior. Pure domain facts, filters for unrelated review actions and existing ordering remain visible in their named command owners.

### Behavior evidence

Six request-booking persistence pins passed against the baseline before movement. They freeze pure transition behavior, voice/lease/save order, existing document-session preservation, failure propagation, conditional predicates and conflict translation. Their unchanged SHA-256 is `e5ff97fbb0978e18da869d3fca4870d81c0a93de27a7175772d420013f8b7ab7`.

Four additional transaction contracts verify ambient read/write binding, read-only replay fence behavior, concurrent attempt isolation, cleanup after errors, explicit legacy sessions and unsupported-operation rejection. The early-return replay keeps the previous absence of a final lease assertion when no write occurred. Actual replica-set integration suites cover staff workflow, stale intake approval and rollback/projections.

| Verification | Result |
|---|---|
| Transition baseline pins before movement | 6 tests passed |
| First migrated integration/pinning selection | 6 suites / 42 tests passed |
| Expanded booking/intake/staff selection | 9 suites / 130 tests passed |
| Whole booking-folder related selection plus all changed files | 211 suites / 8,103 tests passed |
| Explicit recovery/transition suites after the broad selection | 4 suites / 19 tests passed |
| Inventory, authority and check-runtime native negative contracts | 19 tests passed |
| Part 2 full canonical check | Passed all 9 steps; 567 ordinary suites / 11,595 tests; 727.926 seconds |

### Line counts and budgets

| File or function | Before | After |
|---|---:|---:|
| Booking-turn persistence repository | 120 lines | 2-line compatibility export |
| Intake-hold review service | 83 lines | 40 lines |
| Intake actions file | 66 lines | 55 lines |
| Intake actions function | 64 lines | 52 lines; exception removed |
| Request workflow file | 273 lines | 273 lines |
| Request workflow function | 100 lines | 99 lines; exception lowered |
| Request workflow inner run | 91 lines | 90 lines; exception lowered |
| Request workflow transaction callback | 77 lines | 76 lines; exception lowered |
| New persistence owner | — | 155 lines; largest function 29 |
| New transaction owner | — | 34 lines; largest function 8 |
| New stale-hold transition owner | — | 51 lines; largest function 40 |
| API file exceptions, final | 35 | 34 |
| API function exceptions, final | 294 | 291 |

No budget entry was added or increased. The unchanged request-workflow file size is deliberate: session plumbing moved out without repackaging unrelated domain decisions. This is not a claim that its remaining 99-line function has been fully simplified.

### Limits and remaining work

The scan records 202 sites with no locally detected claim/lease token and 355 with no local repair reference. Those counts are audit prompts, not proof that downstream guards or repairs are absent. It also includes 95 dynamic-document candidates and 9 generic tenant-record mutations whose specific record type depends on their caller. The source scanner is a conservative AST inventory, not a whole-program JavaScript proof or runtime MongoDB permission system. Existing domain writers remain individually registered; they have not all been rewritten to call one universal persistence function. New detected raw domain writers are rejected. Dynamic/caller-bound records require the documented manual review, and absent claim/repair evidence is recorded explicitly as a gap rather than invented.

The mechanical inventory/check and request-booking persistence/session migration are implemented. Part 2 remains **partial** against the broader goal: legacy writers are still registered domain primitives, and dynamic records plus missing local guard/repair evidence require manual resolution. Physically routing every existing appointment/booking writer through one runtime transition API is not complete. Completing that safely would require separate baseline tests and migrations for the registered owners, including excluded domains. No claim is made that registration itself fixes a missing tenant/version predicate or establishes an absent repair path.

## Coverage follow-up after the single release run

The final release invocation completed with 36 of 37 gates passing. All 158 differential-coverage test suites passed, but its threshold check failed on three changed-source measurements: intake address restoration (66.67% changed lines, required 90%), request workflow (73.33% changed branches, required 75%), and withdrawal handling (50% changed branches, required 75%).

Five additional tests were written and passed on the first run in an isolated checkout of the identical production code. They cover split-storage address restoration before eligibility, save failure preventing acknowledgement, a read-only legacy lead, withdrawal without a lead save method, and an orphaned review without projections. The new test file was then copied unchanged to the main branch and passed there, followed by all 19 named recovery/transition checks. No production code, frozen test or coverage threshold changed.

Coverage observations from the completed 158-suite run and the five focused tests were merged using Istanbul's coverage library, preserving actual execution counters. The existing diff verifier passes against that merged report: intake changed lines 100%, request workflow changed branches 83.33%, withdrawal changed branches 100%. The original failed release result remains intact. Both coverage observations, the merged report and checker output are included for review.

Per the requested one-run limit, the full release profile was not repeated. Therefore there is **no single all-green whole-profile release run** for the final test/report descendant, even though the only failed check now passes with the supplemental tests and the production code is unchanged. All other 36 release gates passed, including source/runtime/dependency audits; those audits reported six low-severity dependency advisories under the unchanged high-severity failure threshold. Dependencies were not modified.

## Recommended next maintenance work

1. Migrate existing registered domain writers owner by owner, starting with appointment finalization/cancellation and lifecycle repair. Add baseline stale-event, lease-loss and replay pins before each move; remove the old registrations as owners disappear. Inventory registration is not the desired end-state runtime API.
2. Address the characterized original-appointment cancellation race as a separately approved behavior correction. Replacement claims are enforced here; original-lineage reconciliation still needs a version/claim decision coordinated with cancel/update commands.
3. Establish concrete repair paths for inventory entries with empty repair/claim evidence. Prioritize authoritative appointment/conversation writes before cosmetic projections. Do not fill those fields with inferred guarantees.
4. Strengthen scanner dataflow/dispatch coverage with real new source forms as they arise; keep planted bypass tests. Avoid treating a name-based AST inventory as a database authorization mechanism.
5. Reduce the remaining 291 function exceptions incrementally. The request workflow still has a 99-line function; shrinking the reschedule entry does not establish whole-application maintainability.

## Verification discipline and delivery

Replica-set suites run serially. This host prohibits MongoDB Unix sockets; a host-only executable wrapper adds `--nounixsocket` to the unchanged cached MongoDB 7.0.24 binary. No application/test configuration was weakened for the host.

The earlier test-only baseline gate demonstrated the original failure: 563 suites / 11,581 tests passed and one new invariant failed. That was evidence for the authorized correction, not the final candidate result. The earlier baseline release run was interrupted when the user authorized implementation, to avoid verifying source that was about to change. The final candidate release check started at 2026-11-16 00:07 UTC on clean committed code `b942bcb5db68889cd46ae38046bc57d87d0ecd2b`, in the background while this report is finalized outside the checkout. Its completed result is recorded below.

GitHub rejected creation of the requested remote branch with HTTP 403, `Resource not accessible by integration`; the local Git CLI has no authenticated GitHub session. The downloadable package retains the exact local branch, report, tests and verification evidence. The ZIP includes a verified Git bundle, a binary-safe patch, changed files for review, the guarded installer, source hashes and compact machine-readable gate results. No remote branch, PR, deployment, or main/development promotion is claimed.

The bundle installer has been exercised in an isolated clone: import from the exact baseline, repeat application, dirty-checkout rejection and wrong-baseline rejection all passed. It only creates or fast-forwards the maintenance branch at the expected baseline; it does not reset an existing checkout, change main/development or execute live provider operations.

## Final release evidence

**NOT PASSED** — 36 of 37 canonical release steps passed on clean code `b942bcb5db68889cd46ae38046bc57d87d0ecd2b`. Total step execution: 3432.632 seconds. The source identity was unchanged at completion. This is the one completed final-candidate release invocation; it was not repeated to select a favorable result.

The release profile retains all existing gates and adds state-writer enforcement. No existing gate was removed, skipped, downgraded or rebaselined. It includes bounded coverage, differential coverage against the supplied baseline, replica-set persistence, production certification, provider safety and source/runtime/dependency audits.

| Release step | Result | Seconds |
|---|---|---:|
| `lint` | PASS | 10.158 |
| `audit:imports` | PASS | 2.633 |
| `config:inventory` | PASS | 0.194 |
| `contracts:check` | PASS | 2.216 |
| `contracts:state-writers` | PASS | 3.969 |
| `maintainability:complexity` | PASS | 3.661 |
| `maintainability:remediation` | PASS | 1.854 |
| `maintainability:check` | PASS | 0.106 |
| `maintainability:boundaries` | PASS | 0.168 |
| `maintainability:release9` | PASS | 0.193 |
| `maintainability:architecture` | PASS | 60.544 |
| `architecture:invariants` | PASS | 0.132 |
| `verify:index-manifest` | PASS | 0.691 |
| `test:scale-readiness` | PASS | 3.884 |
| `test:durable-persistence` | PASS | 6.656 |
| `test:scale-release` | PASS | 5.743 |
| `test:scale-fleet` | PASS | 4.021 |
| `test:scale-fleet:persistence` | PASS | 3.560 |
| `test:scale-capacity` | PASS | 3.047 |
| `test:scale-query-fixes` | PASS | 4.223 |
| `test:scale-query-fixes:persistence` | PASS | 9.101 |
| `release:gate` | PASS | 0.096 |
| `audit:repository-hygiene` | PASS | 0.221 |
| `benchmark:customer-truth` | PASS | 0.233 |
| `test:ordinary` | PASS | 543.701 |
| `test:coverage` | PASS | 1798.915 |
| `coverage:risk-report` | PASS | 0.131 |
| `verify:coverage-ratchet` | PASS | 0.148 |
| `verify:diff-coverage` | FAIL | 654.688 |
| `test:hardening` | PASS | 155.046 |
| `test:replica-set` | PASS | 18.514 |
| `test:production-certification` | PASS | 73.221 |
| `test:voice-concurrency` | PASS | 26.092 |
| `build:certification` | PASS | 9.746 |
| `audit:source-security` | PASS | 0.254 |
| `audit:runtime-security` | PASS | 9.227 |
| `audit:full-security` | PASS | 15.645 |

Failed gates must be resolved before treating the candidate as release-certified. Exact exit codes and logs are identified in `verification/final-release.results.json`. No deployment or promotion is implied by the successful part-level checks.

Fresh full-suite coverage: lines 87.74%, branches 76.83%, functions 85.71%. The generated summary is included in the ZIP.

Only the supplemental five-test file and this report follow the tested production code commit; no application, contract or script change follows that release evidence. The package records the tested code and delivered test/report commit identities separately.

The unchanged baseline coverage profile excludes `tests/integration/trialRedemptionReplicaSet.concurrency.test.js`; it runs in the ordinary profile. Thus full coverage executed 566 suites / 11,594 tests, while ordinary verification executed 567 suites / 11,595 tests. No new exclusion was introduced, and both frozen pin suites ran.

Source line counts use the repository complexity checker's physical-line measurement (trailing blank lines excluded), not a separate semantic complexity score. The full per-module metrics are included in `verification/maintenance-metrics.json` in the ZIP.

## Stops and decisions

The baseline finalization replay failure initially stopped extraction under the original rule. The user then explicitly directed work to proceed. The recovery correction is identified above, with the unchanged failing test as evidence. No failed pin was edited to accept the refactor.

Physical migration of all historical domain writers was not completed: existing approved owners remain in the inventory, and excluded billing/voice/A2P source was left untouched. The report distinguishes this remaining architectural work from the implemented request persistence boundary. The API-only update superseded the earlier paired-browser/frontend work; this package does not attempt or claim that CI workflow repair.

## Timing

The API workspace was created at 2026-11-15 22:14:19 UTC. The final API-only branch scope began at 22:24:29 UTC (17:24:29 America/New_York). The first diagnostic canonical gate took 807.162 seconds. Part 1 full canonical verification took 729.98 seconds. Part 2 full canonical verification took 727.926 seconds. The Part 1 scope-to-gate window was 58 minutes 43 seconds (22:24:29–23:23:12 UTC). The Part 2 implementation/verification window was about 43 minutes 32 seconds (23:23:12–00:06:44 UTC). Final release step execution took 3432.632 seconds (57.21 minutes). Report finalized at 2026-11-16T01:08:09+00:00. Elapsed API-only scope through report finalization: 163.67 minutes; workspace creation through report: 173.84 minutes. These are elapsed windows including testing/waiting, not a claim of uninterrupted coding time; final packaging takes additional seconds. Parallel report/scanner preparation overlaps check execution and is not summed as additional elapsed time.
