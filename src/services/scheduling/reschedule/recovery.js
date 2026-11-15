/** @typedef {import('./types.js').AppointmentRecord} AppointmentRecord */
/** @typedef {import('./types.js').BusinessScope} BusinessScope */
import { saveClaimed } from './finalize.js';

/** Snapshot only fields that the pre-confirmation error path may restore. */
export function replacementSnapshot(replacement) {
  return { status: replacement.status, confirmedAt: replacement.confirmedAt, heldExpiresAt: replacement.heldExpiresAt,
    externalAppointmentId: replacement.externalAppointmentId, externalCalendarId: replacement.externalCalendarId };
}

/** A lost acknowledgement must never demote an already durable confirmation. */
async function retainPending({ business, original, replacement, snapshot, handoff, error }, { Appointment }) {
  let durable;
  try { durable = await Appointment.findOne({ _id: replacement._id, business: business._id,
    status: 'confirmed', rescheduledFrom: original._id }); } catch { return { uncertain: true }; }
  if (durable?.status === 'confirmed') return { durable: true };
  replacement.status = snapshot.status;
  replacement.confirmedAt = snapshot.confirmedAt;
  replacement.heldExpiresAt = snapshot.heldExpiresAt;
  replacement.externalAppointmentId = snapshot.externalAppointmentId || null;
  replacement.externalCalendarId = snapshot.externalCalendarId || null;
  if (handoff?.applied) {
    replacement.pendingRescheduleExternalAppointmentId = handoff.receipt.externalAppointmentId;
    replacement.pendingRescheduleExternalCalendarId = handoff.receipt.externalCalendarId;
  }
  replacement.failureReason = handoff?.applied
    ? `Provider update applied; local reconciliation required: ${error.message}`
    : `Provider update failed or outcome is uncertain; same-key retry required: ${error.message}`;
  try { await saveClaimed(replacement, { status: 'held', rescheduledFrom: original._id }); }
  catch { /* A newer decision wins; alerting remains the fallback. */ }
  return { durable: false };
}

async function recordIntervention({ business, original, replacement, key, handoff, error }, { InterventionService }) {
  const providerApplied = Boolean(handoff?.applied);
  try {
    await InterventionService.create({ businessId: business._id, leadId: replacement.lead,
      conversationId: replacement.conversation, appointmentId: replacement._id, type: 'integration_failure',
      title: 'Appointment reschedule requires reconciliation',
      message: providerApplied
        ? 'The calendar provider accepted the new appointment time, but CallBackIQ could not finish all local reschedule writes.'
        : 'CallBackIQ could not conclusively determine the calendar provider outcome. The replacement slot remains held to prevent a conflicting booking.',
      priority: 'high', reason: error.message,
      recommendedAction: 'Retry the exact same reschedule operation before making another calendar change.',
      metadata: { provider: original.provider || 'internal', providerApplied,
        providerHandoffStaged: Boolean(handoff?.receipt.externalAppointmentId),
        originalAppointmentId: String(original._id), replacementAppointmentId: String(replacement._id), idempotencyKey: key },
      dedupeKey: `reschedule_reconciliation:${original._id}:${key}` });
  } catch { /* Preserve the original error. */ }
}

/** Persist recovery evidence and translate the existing error contract.
 * @param {{business:BusinessScope, original:AppointmentRecord, replacement:AppointmentRecord, key:string, snapshot:object, handoff:import('./types.js').HandoffResult|null, error:Error}} input
 * @returns {Promise<void>} */
export async function recoverReschedule(input, { Appointment, InterventionService }) {
  const { business, original, replacement, handoff, error } = input;
  await retainPending(input, { Appointment });
  await recordIntervention(input, { InterventionService });
  error.statusCode = error.statusCode || 503;
  error.code = handoff?.applied ? 'RESCHEDULE_RECONCILIATION_REQUIRED' : 'RESCHEDULE_PROVIDER_OUTCOME_UNCERTAIN';
  error.safeCustomerMessage = "I couldn't safely finalize that calendar change. The requested replacement time is being protected while CallBackIQ reconciles the provider outcome.";
  try { await InterventionService.integrationFailure({ businessId: business._id, leadId: replacement.lead,
    conversationId: replacement.conversation, appointmentId: replacement._id, provider: original.provider || 'internal', error });
  } catch { /* Never mask the reschedule failure with an alerting failure. */ }
}
