# ADR-005 — Tenant-bound owner repositories

Status: implemented locally; complete release certification pending.

## Decision

Owner resource methods bind `tenantRepository(Model, tenantContext(businessId))`
before accepting IDs, filters, input or population. Missing, selector-shaped or
invalid business identities throw `TENANT_CONTEXT_REQUIRED`. The frozen
capability exposes plain-record promises rather than Mongoose documents or
query builders. A caller cannot append `.where()` or call `.save()` to change
its scope. Reads, updates, lists, counts, creates and child removal retain the
bound tenant. Resource updates reject identity changes, pipelines and unsafe
operators. Creation and relationship updates validate tenant-owned references.

The Db compatibility facade retains named `ForBusiness` operations but no longer
exports the previous ID-only read/update/delete methods. Archive and restore use
the same scoped update mechanism as ordinary owner mutations; authorization
followed by an ID-only write is prohibited. Message history and pagination now
require an explicit tenant and cannot expose an inconsistent historical foreign
message referencing an owned conversation. Support owner creation, read, update and close operations and subscription access reads require context too. Intelligence listings and counts use
the same bound scope. No new limits or product filtering are introduced.

## Privileged operations

`repositories/privileged/adminRepository.js` is the explicit ID-only seam for
customer resources. Each call reloads the acting user's database role and
requires an operation code; a demoted admin cannot reuse an old capability.
The combined owner/admin conversation access entry imports it. Support administration uses a named privileged support command, with a fixed model, audit purpose and response projection.
Privileged events include actor, resource and operation identifiers. Business
and subscription deletion are excluded: they must retain their existing
provider receipt and transactional domain protocols.

## Compatibility and diagnostics

The HTTP adapter preserves existing missing (400) versus forbidden (401)
responses. It first performs a tenant-scoped data read. Only on a miss does the
repository issue an existence-only ID query, returning no foreign fields. This
is an explicit metadata exception, not a foreign document load.

Populate predicates are static for a bound query. The existing per-document
Mongoose guard discarded owned projected children when `business` was absent
from the selected child fields; the static tenant predicate preserves positive
population while excluding historical foreign references. The legacy unscoped
fallback remains only for other unchanged internal model callers.

Failures propagate unchanged and emit one structured
`repository.tenant_operation_failed` event with business, operation, model and
stable code; record bodies and customer fields are omitted.

## Verification and maintenance

Real MongoDB contracts cover missing context, foreign IDs and references,
positive reads/creates/updates/deletes, population, unsafe update shapes,
history pollution, authorization-to-archive transfer races, database failure
visibility, and fresh admin authorization/demotion. Authenticated HTTP suites
preserve owner/admin routes, archive, intelligence, leads, calls and messages.
The architecture command executes these behavioral contracts. Superseded
extraction hashes remain recorded as review history; retired ID-only methods
cannot be restored. Unchanged source-parity and import-boundary checks remain.

No schema change or migration is required. Legacy invalid cross-tenant records
are excluded during reads; this change does not rewrite stored data.
