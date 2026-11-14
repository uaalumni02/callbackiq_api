# Bounded maintenance entry points and deferred work

Baseline API `4c1be13`, frontend `545c1fc`. [BASELINE.md](../BASELINE.md) records
the check commands and existing API release failures. No API business operation,
schema, provider adapter or worker is refactored in this pass.

## Current entry points

| Concern | Current owner |
|---|---|
| Booking-turn orchestration | `src/services/booking/bookingStateMachine.service.js` and its named turn handlers |
| Booking policy decisions | `src/services/booking/*.policy.js`; now protected transitively by the import audit |
| Appointment commands and recovery wiring | Unchanged `src/services/scheduling/appointment.service.js` and `commands/` |
| Database compatibility facade | Unchanged `src/db/db.js` and `repositories/` |
| Full local/release verification | Unchanged `scripts/check.mjs`, profiles and compatibility aliases |
| Selected dependency enforcement | `scripts/import-graph-audit.mjs` and new `scripts/feature-boundaries.mjs` |
| Partner Leads editor | Frontend `src/features/leads/useLeadEditor.js`, composed by `useLeadsController.js` |

`npm run maintainability:hotspots` now reports entry points together with their
listed feature collaborators: booking, appointments, database repositories, SMS
messaging and admin reporting. JSON output includes each group's exact membership
and per-file counts. Tests/fixtures are excluded and groups may overlap. Counts
are structural signals, not cyclomatic complexity or proof of behavior.

## Future work only

| Debt at baseline | Separate future task |
|---|---|
| `src/services/scheduling/commands/reschedule-1.js`: ~427-line reschedule | Characterize provider handoff/replay, then separate preparation, handoff, finalization and follow-up |
| `src/services/scheduling/appointment.service.js`: broad dependency bags | Narrow one command interface while preserving methods and ordering |
| Generated `createAppointment...1Methods` / `createDb...1Methods` names | Rename only within a dedicated caller/parity-tested change |
| Frontend `src/features/appointments/useAppointmentsController.js` | Characterize availability, intake review and idempotency before changing ownership |
| `src/services/admin/founderReporting.service.js`: 511-line `refreshBusinessReport` | Separate data loading from deterministic report construction without changing financial definitions |

The reschedule flow, appointment wiring, database facade, recovery-intake context,
founder reporting and frontend appointment controller are untouched. Existing
coverage thresholds, size allowances, original named-cycle set and token/path/
body-hash guards are preserved. Old Phase 0 maps and REFACTOR_LOG entries are
marked historical. Vite is implemented in the frontend.
