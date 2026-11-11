# Tenant boundaries and external effects

Accepted for this remediation candidate, November 10, 2026. Reassess with production observations after release.

Owner mutation inputs are explicit DTOs. Tenant ownership is resolved from authentication and cannot be changed in a PATCH. References must exist under that same tenant. Populated conversation/call references receive a tenant match; these models' business fields are immutable through Mongoose. This protects reads of historically inconsistent rows while a read-only integrity scan identifies rows needing investigation. Raw MongoDB access remains privileged and bypasses Mongoose safeguards.

An external provider HTTP acknowledgement does not itself complete a local operation. Stripe event completion is conditional on a claim token; uncompleted duplicates ask Stripe to retry. Trial email acceptance produces a durable receipt before the subscription projection. Ambiguous email outcomes require receipt review. Trial extension intent fixes the target and reserves the allowance before the remote mutation. Notifications finish only under the current claim. No SMTP exactly-once promise is made.

All scheduling providers enter confirmation recovery. An adapter declares whether availability is local or external and whether its outcome is recoverable or requires external verification. A Jobber request-only handoff cannot confirm a customer visit. An ambiguous non-idempotent provider mutation remains pending for investigation. The adapter seam is deliberately narrower than a provider-neutral business rule layer; internal scheduling remains the explicit availability authority for Jobber.

The large SMS/voice workflows were split along existing policy and lifecycle boundaries with characterization tests. This release keeps workflow order, per-call state and public controller entry points. It does not introduce a second workflow engine or switch the transport/provider stack. Future changes should replace one stage or adapter under these tests.

Rollback: restore source from the package journal and reinstall matching locked dependencies. New schema fields are additive and new indexes are not dropped. Do not erase persisted receipts, grants, claims or confirmation intents during rollback; earlier code cannot safely reinterpret all newer recovery state. Roll back customer traffic only through a reviewed release procedure if such state is present.
