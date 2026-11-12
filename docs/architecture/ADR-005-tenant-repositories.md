# ADR-005 — Tenant-scoped repository interfaces

Status: PROPOSED; repository migration not implemented in this draft.

## Decision

Owner-facing repository operations require a validated tenant context derived
from authentication plus a document ID. The interface is
`operation(tenantContext, documentId, input)`, never an optional business filter.
Each lookup, update, populate and reload retains that tenant. Callers cannot
change tenant identity through DTOs or update operators.

ID-only operations move into an explicitly named privileged repository module.
Owner controllers cannot import it; enforce the import boundary in CI. Admin
entry points authorize privilege before entering that module and include the
actor and target tenant in structured events. Archive must use the owner
interface too; an authorization read followed by an ID-only write is insufficient.

## Verification required

Use authenticated HTTP and real MongoDB tests for owner read, update and archive;
foreign IDs and foreign lead references; missing tenant context; and races
between authorization and mutation. Keep a privileged-path test proving admin
behavior remains intentional. Existing Mongoose immutability/populate defenses
remain defense in depth, not a substitute for required tenant context.

No schema change or data migration is needed for this interface decision. The
actual call-site migration belongs to root cause 3 after the agreed green gate
prerequisite.
