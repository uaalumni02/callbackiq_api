/** A single source of truth for action and outcome vocabulary. */
export const OUTCOME = Object.freeze({
  REQUEST_RECORDED: 'request_recorded', STAFF_TASK_QUEUED: 'staff_task_queued',
  STAFF_ACCEPTED: 'staff_accepted', APPOINTMENT_PENDING: 'appointment_pending_approval',
  APPOINTMENT_CONFIRMED: 'appointment_confirmed', SMS_ATTEMPTED: 'sms_attempted',
  SMS_ACCEPTED: 'sms_accepted_by_provider', SMS_DELIVERED: 'sms_delivered',
  SMS_UNCERTAIN: 'sms_delivery_uncertain', VOICE_COMPLETED: 'voice_turn_completed',
});
const allowed = new Set(Object.values(OUTCOME));
// Observable evidence only: *never* interpret a model assertion or a sent
// handoff acknowledgement as staff acceptance or dispatch confirmation.
export function verifyOutcome(proposed, evidence = {}) {
  if (!allowed.has(proposed)) return { verified: false, reason: 'unknown_outcome' };
  const checks = {
    [OUTCOME.REQUEST_RECORDED]: () => evidence.requestPersisted === true,
    [OUTCOME.STAFF_TASK_QUEUED]: () => Boolean(evidence.alertId && evidence.alertPersisted === true),
    [OUTCOME.STAFF_ACCEPTED]: () => Boolean(evidence.staffActorId && evidence.staffAcceptancePersisted === true),
    [OUTCOME.APPOINTMENT_PENDING]: () => Boolean(evidence.appointmentId && evidence.authoritativeStatus === 'pending_business_confirmation'),
    [OUTCOME.APPOINTMENT_CONFIRMED]: () => Boolean(evidence.appointmentId && evidence.authoritativeStatus === 'confirmed'),
    [OUTCOME.SMS_ATTEMPTED]: () => Boolean(evidence.messageId && evidence.attemptPersisted === true),
    [OUTCOME.SMS_ACCEPTED]: () => Boolean(evidence.providerMessageId && evidence.providerAccepted === true),
    [OUTCOME.SMS_DELIVERED]: () => Boolean(evidence.deliveryReceiptId && evidence.providerDeliveryStatus === 'delivered'),
    [OUTCOME.SMS_UNCERTAIN]: () => evidence.deliveryStatus === 'uncertain',
    [OUTCOME.VOICE_COMPLETED]: () => evidence.voiceTurnFinalized === true,
  };
  const verified = checks[proposed]() === true;
  return { verified, reason: verified ? 'verified' : 'missing_authoritative_evidence' };
}
