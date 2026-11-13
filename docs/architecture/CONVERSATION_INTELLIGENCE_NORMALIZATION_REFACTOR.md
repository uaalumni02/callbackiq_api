# Conversation Intelligence schema and normalization extraction

Base: `a41bd0983969fc2b98a08d05b31ed0c9d90d5047` on `development`.
Branch: `refactor/ci-normalization-policy`.
Application source verified at `6346079`; the subsequent report commit changes documentation only.

## Result and scope

The provider schema is in `src/services/conversationIntelligence.schema.js`. Pure preparation,
field normalization, enum/legacy fallbacks, text limits, risk filtering and validation are in
`src/services/conversationIntelligenceNormalization.policy.js`. The existing service retains
provider/client management, transcript construction, configuration, guardrails, catalog reads,
valuation and their original sequencing. No frontend files, dependencies, routes, models,
provider prompt wording or unrelated services were changed.

All implementation phases are complete. Publishing is blocked: the GitHub connector returned
HTTP 403 `Resource not accessible by integration` for branch creation, and normal Git push
failed because this environment has no GitHub credentials. No PR was created and nothing was
merged. The delivery bundle preserves all local commits and their order.

## Counts and allowances

Counts use the existing ratchet's `trimEnd().split("\n").length` convention.

| Item | Before | After |
|---|---:|---:|
| Conversation Intelligence service file | 1,013 | 409 |
| Extracted schema file | absent | 285 |
| Schema declaration itself | 283 | 283 |
| Extracted policy file | absent | 288 |
| Existing private service `normalizeAnalysis` | 172 | 18 |
| Largest policy function | n/a | 51 |
| A2P onboarding service (runtime source unchanged) | 1,162 | 1,162 |

| Complexity allowance | Before | After |
|---|---:|---:|
| A2P service file | 1,239 | 1,162 |
| Conversation Intelligence service file | 1,013 | 409 |
| Service `normalizeAnalysis` function | 172 | removed; now below the 60-line limit |

No exception was added or enlarged. File/function thresholds remain 400/60.
The existing `buildTranscript` (65) and `analyze` (211) allowances are unchanged.
`config/environment-inventory.json` and `docs/CONFIGURATION.md` were regenerated because
source line references moved. The same 338 configuration names remain; no setting changed.

## Phase 0 findings and preserved timing

The service has exactly one export: default `ConversationIntelligenceService`.
Its async static `analyze` signature and complete method body are unchanged. No schema or
normalizer helper was previously exported, so no compatibility re-export is necessary.
Existing importers (including mocks) are:

- `src/controllers/conversationIntelligence/context.js`
- `tests/routes/conversationIntelligence.routes.test.js`
- `tests/unit/conversationIntelligence.contract.test.js`
- `tests/unit/conversationIntelligence.controller.test.js`
- `tests/unit/opportunityIntelligence.test.js`

| Environment read | Original timing, retained |
|---|---|
| `CONVERSATION_INTELLIGENCE_MAX_MESSAGES` | Module load; integer parse, default 200, clamp 10–1,000 |
| `CONVERSATION_INTELLIGENCE_MAX_CHARACTERS` | Module load; integer parse, default 50,000, clamp 5,000–200,000 |
| `OPENAI_API_KEY` | Each `analyze` entry; then conditional client validation, cache comparison, cache assignment and client options reads inside `getOpenAIClient` |
| `OPENAI_CONVERSATION_MODEL`, then `OPENAI_MODEL`, then default | Per call before the provider request; independently read again at the end of normalization for `modelUsed` |

Guardrails run in the middle of normalization. `prepareAnalysisNormalization` computes buying
score, appointment score, urgency fallback and legacy action mapping first. The service then
calls `buildBusinessCapabilities` and `sanitizeOutboundReply`. The latter still receives the
raw provider `suggestedMessage`, raw intent category (or its existing `unknown` fallback),
mapped guardrail action, capabilities, cleaned business name and the same disclosure flags.

Only after that call does `finalizeAnalysisNormalization` construct fields and filter risks.
The service then resolves a plain `{modelUsed}` configuration object and calls `withAnalysisModel`.
This preserves the late environment read, including model changes during provider or guardrail work.
Authoritative valuation still follows full normalization and precedes meaningful-analysis validation.
The earlier transcript redaction, business-context capabilities and verified-facts calls are unchanged.

The policy imports only the existing pure shared contract. Existing boundary tooling and an AST
check enforce the absence of database, model, provider, environment, clock, randomness, dynamic
import and logging access. Pure direct tests use plain inputs without DB/OpenAI/environment mocks.

## Characterization and mutation evidence

Before moving application code, 121 fixtures were executed through the original service.
They freeze full serialized provider-request bytes, normalized output, thrown error type/message/code,
and ordered guardrail call arguments/results. Real guardrail implementations are wrapped for
observation; controlled sanitizer results additionally exercise the normalization message-length ceiling.
The schema has its own frozen JSON fixture. Fixture hashes have not changed since characterization.

Coverage includes happy and malformed responses, missing/null fields, score bounds and invalid
values, all current action fallbacks, both legacy mappings, unknown enums, all five text limits
(one under/exact/one over using ASCII and multibyte text), filtered and surviving risk/objection
items, array caps, clean and fallback guardrails, model precedence, changes during provider/guardrail
work, transcript module-load limits and their persistence after later environment changes.
Error cases include the service's explicit rejections and provider/DB/guardrail/valuation errors,
malformed timestamps, invalid provider output types and invalid guardrail results.

| Deliberate temporary mutation | Targeted assertion failures | Runtime/syntax failures | Restored |
|---|---:|---:|---|
| Unknown intent fallback changed to `other` | 1 | 0 | yes |
| Explanation limit reduced by one | 1 | 0 | yes |
| `send_estimate` mapping changed to `none` | 1 | 0 | yes |

All 121 characterization cases passed again after every mutation was reverted, before application
extraction. They also passed after schema extraction and after policy extraction with no snapshot updates.

## Verification environment

Runtime: Node 24.22.1. Tests use the repository's existing
`verificationEnvironment('callbackiq_api')` with synthetic provider configuration and external writes
blocked. MongoDB 7.0.24 was already cached. Its initial exit code 100 was diagnosed as
`open: Operation not permitted` while opening its Unix socket in this host. A temporary launcher
outside the repository adds `--nounixsocket` to the same cached binary through `MONGOMS_SYSTEM_BINARY`.
Standalone and replica-set startup succeeded with that launcher. No dependency, application config,
or test database helper was changed. Mongo-backed suites were actually executed and passed.

## Commands and results

The initial relevant baseline command was:

```bash
npm test -- --runInBand \
  tests/unit/conversationIntelligence.contract.test.js \
  tests/unit/conversationIntelligence.persistence.test.js \
  tests/unit/conversationIntelligence.controller.test.js \
  tests/unit/opportunityIntelligence.test.js \
  tests/routes/conversationIntelligence.routes.test.js \
  tests/integration/conversationIntelligence.persistence.test.js
```

Result: **95 passed across 6 suites** on the unmodified service.

| Command | Result |
|---|---|
| `npm run maintainability:complexity` before Phase 1 | Expected FAIL: stale A2P 1,239 allowance versus measured 1,162 |
| `node scripts/complexity-budget.cjs --tighten --owner @uaalumni02` | PASS; only reductions/removal |
| `npm run maintainability:complexity` after Phase 1 | PASS |
| `npm test -- --runInBand tests/unit/conversationIntelligence.characterization.test.js` | 121/121 PASS before extraction, after schema extraction and after policy extraction |
| `npm test -- --runInBand tests/unit/conversationIntelligence.characterization.test.js tests/unit/conversationIntelligenceNormalization.policy.test.js tests/unit/conversationIntelligenceNormalization.boundary.test.js` | 243/243 PASS across 3 suites |
| `npm run test:ordinary -- --json --outputFile=ci-full-tests.json` | **11,574/11,574 PASS across 563 suites**, zero failed/pending/skipped |
| `npm run lint` | PASS |
| `npm run audit:imports` | PASS |
| `npm run config:inventory` | PASS |
| `npm run maintainability:check` | PASS |
| `npm run maintainability:boundaries` | PASS |
| `npm run maintainability:architecture` | PASS |
| `npm run maintainability:release9` | PASS |
| `npm run architecture:invariants` | PASS |
| `npm run maintainability:remediation` | PASS |
| `npm run maintainability:complexity` | PASS |
| `npm run test:hardening` | PASS |
| `npm run build:certification` | PASS |
| `npm run maintainability:complexity -- --base a41bd09` after final tightening | PASS; no new/enlarged allowances relative to the original base |
| `./node_modules/.bin/eslint` on the characterization test, direct policy test, boundary test and fixture generator | PASS |
| `git diff --check` | PASS |
| Exact-source comparison of schema expression, 6 retained orchestration definitions and 11 moved rule implementations | PASS |
| SHA-256 comparison of all frozen JSON fixtures against Phase 2 | PASS |

The hardening command executed **216 tests**, with zero failures or skips.
The architecture command executed **314 tenant behavioral contracts across 16 suites** and
validated 30 unchanged source-parity contracts. Production build compiled **728 ES modules**.
The import audit checked **1,526 files / 5,343 local import edges**.

The full regression run includes:

| Category | Suites | Tests |
|---|---:|---:|
| Unit | 392 | 5,427 |
| Integration, including Mongo/replica-set persistence | 87 | 692 |
| Routes | 35 | 424 |
| Services | 17 | 4,677 |
| Controllers | 7 | 94 |
| Other existing categories | 25 | 260 |
| **Total** | **563** | **11,574** |

No required suite remains unverified. This is local verification; branch publication/PR creation
was blocked by credentials. Coverage/release certification beyond the explicitly listed checks
and live production/provider activity are not claimed.

## Discrepancies and deliberately preserved oddities

- The schema declaration measures **283**, rather than the approximate 284 lines in the brief.
  The 1,013-line service, 172-line normalizer and 1,162-line A2P service figures are correct.
- The generated environment inventory also had stale A2P source line references from the earlier
  extraction. Required regeneration repairs those references while retaining every existing setting.
- The previous Mongo startup problem is reproducible but environmental; disabling the host-forbidden
  Unix socket externally restored the actual Mongo suites and replica-set tests.
- Missing/non-finite sentiment scores still fall back to **-1**, because the generic clamp uses
  its lower bound. This surprising behavior was not changed.
- Text limits still count UTF-16 code units and can split a surrogate pair; a direct test preserves it.
- `modelUsed` can differ from the request model if configuration changes while provider/guardrail work
  is pending. Both reads and this behavior remain intact.
- The transcript keeps the first selected complete line even if it alone exceeds the character budget,
  and may add an omission marker afterward. This soft-limit behavior remains intact.
- The defensive `next best action is missing` validation branch is unreachable through ordinary JSON
  provider output because normalization always supplies a readable fallback. Its unchanged validation
  branch is tested directly, including the combined-error message.

## Review

The application/configuration diff and new tests were reviewed. The public export surface is unchanged;
request prompt and payload construction, database query, client cache behavior, valuation placement and
async method body remain source-identical. No moved dead definitions remain in the service, no constants
were duplicated, and no dependency was added. Only documentation/inventory source references accompany
the runtime extraction. All immutable fixtures match their committed pre-extraction hashes.
