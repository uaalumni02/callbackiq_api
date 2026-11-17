import { rescheduleReceiptIdentity } from '../../stateTransitions/appointmentOwnership.js';
/** @typedef {import('./types.js').AppointmentRecord} AppointmentRecord */
/** @typedef {import('./types.js').BusinessScope} BusinessScope */
/** Preserve the document's existing session/hooks while adding an observed-state claim. */
export async function saveClaimed(document, claim) {
  const prior = document.$where;
  document.$where = prior ? { $and: [prior, claim] } : claim;
  try { await document.save(); } finally { document.$where = prior; }
}

/** @param {{business:BusinessScope, original:AppointmentRecord, replacement:AppointmentRecord|null, key?:string, service?:import('./types.js').Service, nextInput?:object}} input
 * @returns {Promise<{replacement:AppointmentRecord}>} */
export async function reserveReplacement({ business, original, replacement, key, service, nextInput, input }, { createHold }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Reschedule input is required before reserving a replacement.'), { code: 'RESCHEDULE_INPUT_REQUIRED', statusCode: 400 });
  if (!replacement) replacement = await createHold({ business, service, input: nextInput,
    preservedValuation: { estimatedValue: original.estimatedValue, valuation: original.valuation || { source: 'legacy_unverified' } },
    idempotencyKey: key, excludeAppointmentId: original._id });
  if (!replacement.rescheduledFrom && replacement.status === 'held') {
    replacement.rescheduledFrom = original._id;
    replacement.rescheduleInputFingerprint = rescheduleReceiptIdentity(input);
    await replacement.save();
  }
  return { replacement };
}

/** Persist the receipt before releasing the original's unique provider-event link.
 * @param {{original:AppointmentRecord, replacement:AppointmentRecord, handoff:import('./types.js').HandoffResult}} input
 * @returns {Promise<{staged:true}>} */
export async function stageHandoff({ original, replacement, handoff }) {
  if (handoff.resumed) return { staged: true };
  const { receipt } = handoff;
  replacement.provider = receipt.provider;
  replacement.pendingRescheduleExternalAppointmentId = receipt.externalAppointmentId;
  replacement.pendingRescheduleExternalCalendarId = receipt.externalCalendarId;
  replacement.failureReason = '';
  replacement.providerOperation = { ...replacement.providerOperation?.toObject?.(), kind: 'reschedule', state: 'applied' };
  await replacement.save();
  original.externalAppointmentId = null;
  original.externalCalendarId = null;
  await original.save();
  return { staged: true };
}

/** A replacement may finalize only while it owns its observed hold and lineage.
 * @param {{replacement:AppointmentRecord, receipt:import('./types.js').ProviderReceipt}} input
 * @returns {Promise<{appointment:AppointmentRecord}>} */
export async function confirmReplacement({ replacement, receipt }, { lifecycleMarker }) {
  const claim = { status: 'held', rescheduledFrom: replacement.rescheduledFrom,
    pendingRescheduleExternalAppointmentId: replacement.pendingRescheduleExternalAppointmentId ?? null };
  replacement.lifecycleNotice = lifecycleMarker('rescheduled');
  replacement.status = 'confirmed';
  replacement.providerOperation = { ...replacement.providerOperation?.toObject?.(), kind: 'reschedule', state: 'resolved' };
  replacement.confirmedAt = replacement.confirmedAt || new Date();
  replacement.heldExpiresAt = null;
  replacement.provider = receipt.provider;
  replacement.externalAppointmentId = receipt.externalAppointmentId;
  replacement.externalCalendarId = receipt.externalCalendarId;
  replacement.pendingRescheduleExternalAppointmentId = null;
  replacement.pendingRescheduleExternalCalendarId = null;
  replacement.failureReason = '';
  await saveClaimed(replacement, claim);
  return { appointment: replacement };
}

/** Finalize original lineage after the replacement owns the provider event.
 * @param {{original:AppointmentRecord, replacement:AppointmentRecord}} input
 * @returns {Promise<{reconciled:true}>} */
export async function reconcileOriginal({ original, replacement }, { assertTransition }) {
  if (original.status === 'rescheduled') return { reconciled: true };
  assertTransition(original.status, 'rescheduled');
  if (original.rescheduleRequest?.status === 'pending') {
    original.rescheduleRequest.status = 'approved';
    original.rescheduleRequest.decidedAt = new Date();
    original.rescheduleRequest.alertPending = true;
  }
  original.status = 'rescheduled';
  original.rescheduleIntent = undefined;
  original.rescheduledTo = replacement._id;
  original.activeSlotKey = null;
  original.slotClaimKeys = [];
  original.capacityLane = null;
  original.externalAppointmentId = null;
  original.externalCalendarId = null;
  await saveClaimed(original, { status: 'confirmed', business: original.business });
  return { reconciled: true };
}
