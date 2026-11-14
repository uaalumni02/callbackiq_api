# One local check and one release gate

Use Node 24 LTS, version 24.19 or later, and npm 11:

```sh
npm ci
npm run check
npm run check:release -- --base <comparison-commit>
```

`check` is for an editing tree: lint, all static and literal dynamic imports, generated configuration and API contracts, exact complexity budgets, ordinary Jest, every native hardening suite and the production build. `check:release` requires clean, committed source and adds every existing CI architecture/scale check, environment validation, hygiene, the customer-truth benchmark, full coverage and its unchanged risk/ratchet/diff policies, replica-set contracts, deterministic customer journeys, voice concurrency repository source security and runtime/full dependency audits. `config/check-plan.json` is the authoritative order. The `test:production-hardening-v1` cases are also discovered by the complete native hardening step.

The runner identifies the repository from `package.json`, selects Node 24 before any check, and pins that executable after npm prepends local and ancestor executable directories. It uses a temporary npm script shell and removes it when complete. It does not edit the operator's shell or global npm configuration. Set `MEEKCALL_VERIFY_NODE` to a specific Node 24 executable if selection fails.

Canonical API checks use `verificationEnvironment` from `scripts/check.mjs`. Inherited Stripe/Twilio/OpenAI/Google/mail credentials and database aliases are replaced with inert certification fixtures. The same function supplies the deterministic production-journey child process. Existing test fixtures own their disposable MongoDB instances; these commands do not migrate a live database or make live provider writes. `MONGOMS_SYSTEM_BINARY` and `MONGOMS_VERSION` remain available for a compatible local MongoDB binary, including a `--nounixsocket` wrapper where required by the host. Real provider connectivity, delivery, account configuration and deployment are not certified by offline fixtures.

All commands write results and complete logs under `.verification/` by default. `--output` selects a different evidence directory. Results identify the exact source commit, runtime and each exit code; failed or skipped/todo Jest cases fail the gate. Coverage/build artifacts must be regenerated during the corresponding step. The API build must produce the HTTP server, app and worker entry points; the frontend build must produce its SPA shell. A source change while the gate runs invalidates its evidence.

## Compatibility

Existing npm check names are labeled aliases in `config/legacy-check-aliases.json`. Old certification and aggregate CI names redirect to the complete release profile. Focused test/verification names print that they are subsets. A subset pass cannot be cited as complete certification. Operational start, database migrations, seeding, performance deployments, generators and cleanup commands retain their original meaning and are excluded from both profiles. In particular, neither profile applies indexes to an operator database.

## Import and complexity contracts

The import audit resolves static imports, reexports, CommonJS requires and every literal dynamic import, including zero-expression template literals. It scans tracked and nonignored engineering files as well as production source. A missing local target fails before bundling without needing to execute the lazy branch. Protected dependency boundaries remain acyclic.

The additional selected API boundary covers production `.policy.js` files under
`src/services/booking/` and their resolved local dependency closure. Cycles and
imports reaching controllers, routes, db, models, integrations or workers fail;
mongoose, twilio, stripe, openai and redis package imports also fail. Indirect
imports through helpers are checked. Computed/nonliteral imports and runtime
effects are outside this static guarantee. The original named cycle set and all
existing token/path/body-hash guards remain unchanged. Negative fixtures live in
`hardening-tests/feature-boundaries.test.mjs`.

Browser PR jobs on `maintenance/paired-*` branches check out the same named
partner branch and record both exact commits before building/testing. Publish
both branches before opening their PRs, and stop pushing while collecting pair
evidence. Other branches retain the existing repository-variable/main fallback.
Read-only tokens, paths, credential persistence and browser tests are unchanged.

The default budgets remain 400 lines per production file and 60 per function. Temporary exceptions have an owner and a machine-checked expiry condition: remove them when the code reaches the default. Each exception equals its measured size. Distinct anonymous callbacks and repeated function names have independent ordinal identities, so smaller functions cannot hide growth behind another function's allowance. The version-2 file makes previously collapsed callbacks visible separately. No production responsibility was moved to manufacture a smaller measurement.

```sh
node scripts/complexity-budget.cjs --tighten --owner @uaalumni02
```

Tightening removes obsolete allowances and reduces existing ones. It cannot approve growth or introduce an exception after the initial identity-format conversion. CI compares the budget against the target revision, including compatibility with the original name-based format.

## Evidence boundaries

Product hardening executes named HTTP, persistence and transport contracts. Real MongoDB tests cover duplicate operation/counter reservations, owner tokens, callback tenant resolution, monotonic outcomes, unexpired voice leases and manual SMS acceptance versus uncertainty. Real WebSocket upgrade rejection is tested on loopback. Provider adapters remain synthetic; source-string matches do not establish those guarantees. Static AST/import, parsed checkout wiring and hygiene-scanner mutation checks remain structural contracts.

GitHub release certification and the intentional broken-import/revert workflow proof remain unverified until the candidate branches can be published and the corresponding workflow runs are observed. Local negative fixtures and a local throwaway commit/revert are retained separately and are never labeled GitHub evidence. A private partner checkout requires `CALLBACKIQ_CROSS_REPO_READ_TOKEN` with read access to both repositories.
