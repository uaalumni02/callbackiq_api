# Bounded maintenance baseline — 2026-11-14

Started at 14:28 UTC. Implementation ends no later than 21:28 UTC, with the
following three hours reserved for verification. Work may finish earlier.
There is no deployment or main/development promotion in this pass.

API baseline: `4c1be137371edd1b03a41f963b3a008e6fb26b9a`.
Frontend baseline: `545c1fcaaedee9c29d6cf79907560e5d0603d4ad`.
GitHub main and development matched in each repository when checked.
The baseline runs in an untouched checkout; tooling changes use a separate
candidate checkout. Both use dependencies installed from the unchanged lockfile.

## Local commands

Runtime: Node v24.22.1, npm 11.9.0. Canonical checks supply inert credentials and
disposable databases. MONGOMS_VERSION=7.0.24 and MONGOMS_SYSTEM_BINARY select an
existing compatible mongod through a host-only `--nounixsocket` wrapper because
this workspace prohibits Unix sockets. This does not change application code.

| Command | Baseline outcome |
|---|---|
| `npm ci --offline` | Failed: uncached yocto-queue tarball; no source changes |
| `npm ci` | Passed; installed 678 packages from the unchanged lockfile |
| `npm run check -- --output ../evidence/callbackiq_api/baseline/check` | Passed in 814 seconds; all 563 ordinary suites / 11,574 tests, native hardening and production build passed |
| `npm run check:release -- --base 4c1be137371edd1b03a41f963b3a008e6fb26b9a --output ../evidence/callbackiq_api/baseline/release` | Completed, exit 1 in 2,794 seconds: only repository hygiene and A2P coverage-ratchet failures; 563 ordinary suites / 11,574 tests and 562 coverage suites / 11,573 tests passed |
| `npm run build` | Passed separately; canonical check and release builds also passed |

Complete command logs and machine-readable results are outside the checkout to
preserve clean source identity. Frontend baseline check, release gate and separate
production build all passed (110 Jest suites / 481 tests).

## Diagnosed remote release failure

Artifact `14098346417` from
[API CI run 43553033315](https://github.com/uaalumni02/callbackiq_api/actions/runs/43553033315)
identifies the exact API baseline. Its `results.json` records two failures:

- Repository hygiene: OPENAI_API_KEY fixture in
  `tests/unit/conversationIntelligence.characterization.test.js`.
- Coverage ratchet: `src/services/a2pCustomerOnboarding.service.js` branches
  53.79% vs 54.36%, lines/statements 31.23% vs 31.34%.

Ordinary Jest (563 suites / 11,574 tests), bounded coverage (562 suites / 11,573
tests), deterministic production certification and build passed in that run.
The direct log endpoint returned a transport error; the downloaded workflow
artifact provides the diagnosis. These are existing failures, not waived checks.
No A2P logic, fixture, scanner or coverage policy is changed in this pass.

## Verification and scope limits

Only import tooling, its negative tests, reporting/documentation and paired-branch
browser checkout are changed here. API business operations are untouched.
No coverage threshold, size allowance, named-cycle check or token/path/body-hash
guard is weakened. Existing release failures prevent a fully green release claim.
Local Chromium also cannot launch because host Unix sockets are prohibited;
paired PR browser jobs are required for remote browser evidence. They were not
executed: branch creation returned 403 (Resource not accessible by integration)
in both repositories, and the local Git CLI was not authenticated. No remote
feature branches or PRs were created. A local exact-pair browser attempt failed
in both suites during browser setup; no browser assertions executed.
