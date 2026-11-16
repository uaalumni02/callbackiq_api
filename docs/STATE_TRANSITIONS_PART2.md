# Part 2: state writers use centralized transitions

Baseline: API `0a7f480bab9f13d588ba0804f5bfdbb927f173d3`; frontend
`025e4b190a3ceea2f9ece92c0ac4f3361dc230d3`.

The remaining inventoried mutations now pass through named commands in
`src/services/stateTransitions/`, alongside the existing booking persistence,
transaction, appointment-booking projection and reschedule transition owners.
This moves 330 expressions from 109 callers. The migration includes staff
reviews, SMS, voice, appointment creation/confirmation/cancellation/expiry,
provider change review, recovery cases/events, lifecycle projections and generic
tenant/privileged repositories. No frontend source change is needed.

## Ownership

| Module in `src/services/stateTransitions/` | Responsibility |
| --- | --- |
| `documents.js` | Native document saves, including optional saves |
| `requestIntake.js` | Intake invalidation, reviewed names and customer appointment acknowledgements |
| `appointmentCommands.js` | Appointment decision fields and reholding |
| `appointmentLifecycle.js` | Confirmation claims, expiry, approval notices, lifecycle/projection repair and reschedule requests |
| `messaging.js` | SMS ingress snapshots, request revisions, handoff state and reply persistence |
| `voice.js` | Voice outcomes, handoff/review state and callback projections |
| `reviews.js` | Assignment, acknowledgement, resolution and notification claims |
| `recoveryCoordinator.js` | Versioned recovery decisions and transactional audit events |
| `integrations.js` | Provider-change review state |
| `customerRequest.js` | Conversation controls, eligibility and request workflow staging |
| `customerProjections.js` | Customer lifecycle, attribution and valuation projections |
| `tenantRecords.js` | Tenant-bound and privileged repository mutations |
| `accountRecords.js` | Existing account and subscription conditional writes |

The commands own the exact relocated mutation expressions: predicates, update
operators, write options and document receivers. Existing callers retain policy
choices, preconditions, lease assertions, provider ordering, transaction lifetime,
result inspection and repair invocation. Some established predicates and patches
remain explicit capability inputs. This is a persistence ownership migration;
it introduces no new business rule, transaction, schema or runtime authorization.

Document commands return the native result synchronously. They neither await nor
wrap a Mongoose query or save promise. Existing `.select()`, `.session()`, `.lean()`,
validation/save hooks, error handling and optional-save behavior therefore retain
their original composition. No tenant/version predicate or repair path was invented
where the baseline lacked one.

## Enforcement and preservation

`npm run contracts:state-writers` now rejects raw registered writers outside the
transition owners. The previous registration is no longer a bypass exemption, and
regeneration cannot approve such a writer. Pure `typeof save` capability checks
remain inventoried without being treated as mutations. Optional calls, aliases,
destructured repository models and member-held repository models are recognized.
The latter two exposed seven additional generic repository writes; recovery audit
events added two more sites beyond the original 321-expression migration.

`contracts/state-transition-migration.json` records each expression, its command
call and the complete original caller AST digest. The preservation verifier checks
that the command still contains the original expression, restores it at the call
site, removes only the new transition imports, and compares the entire file with
the baseline. This pins surrounding guards, branches and effect order as well as
the MongoDB operation. It requires no Git history at verification time. Negative
contracts change tenant predicates, remove an outer lease guard and add an effect
to demonstrate rejection. Existing extraction-body records retain their previous
hash in `preTransitionMigrationSha` when a reviewed relocation changes the body.
Their exact new imports are reviewed; unrelated records keep their original hash.

The inventory remains a conservative source analysis, not a whole-program proof
of dynamic JavaScript or a runtime MongoDB permission boundary. Moving a legacy
mutation does not certify that its preexisting concurrency/repair policy is ideal.
The completion claim is the migration and its enforced source boundary, not a
claim that every historical business workflow has been redesigned.

## Validation

Run `npm run check` for the canonical local profile. It includes inventory and
preservation verification, the full ordinary suite, native hardening contracts,
imports, complexity and the production build. The unchanged frontend should also
pass `npm run check`. Focused additions are:

- `tests/unit/stateTransitionCommands.contract.test.js`: save receiver/options,
  native promise/query identity, optional-save failure behavior, reviewed-name
  compare-and-set, confirmation claims, recovery sessions and batch tenant scope.
- `hardening-tests/state-transition-migration.test.mjs`: baseline reconstruction
  and planted behavioral changes.
- `hardening-tests/state-writers.test.mjs`: registered raw bypass rejection,
  optional saves, transition aliases and destructured/member model detection.

No complexity allowance or coverage threshold is increased. No deployment,
remote promotion or data migration is part of this change.
