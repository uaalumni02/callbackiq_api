import { rescheduleReceiptIdentity } from '../../stateTransitions/appointmentOwnership.js';
/** @typedef {import('./types.js').AppointmentRecord} AppointmentRecord */
/** @typedef {import('./types.js').BusinessScope} BusinessScope */
/** @typedef {import('./types.js').RescheduleRequest} RescheduleRequest */
const conflict = (message, code) => Object.assign(new Error(message), { statusCode: 409, ...(code ? { code } : {}) });

function assertCurrentRequest(original, input) {
  if (input.requestId && (original.rescheduleRequest?.id !== input.requestId ||
      !['pending', 'approved'].includes(original.rescheduleRequest?.status) ||
      +new Date(original.rescheduleRequest.startAt) !== +new Date(input.startAt) ||
      +new Date(original.rescheduleRequest.endAt) !== +new Date(input.endAt))) {
    throw conflict('The customer request changed. Reload before approving.');
  }
}

/** Reads and validates identity; does not persist a document. @param {RescheduleRequest} request
 * @returns {Promise<{original:AppointmentRecord, replacement:AppointmentRecord|null, key:string}>} */
export async function readReschedule(request, { Appointment, getAppointmentForBusiness, normalizeAddress, crypto }) {
  const { business, appointmentId, input, idempotencyKey } = request;
  if (input.address !== undefined) normalizeAddress(input.address);
  const original = await getAppointmentForBusiness(business._id, appointmentId);
  assertCurrentRequest(original, input);
  const key = String(idempotencyKey || input.idempotencyKey || `reschedule:${original._id}:${crypto.randomUUID()}`).trim();
  const replacement = await Appointment.findOne({ business: business._id, idempotencyKey: key });
  if (replacement?.rescheduleInputFingerprint && replacement.rescheduleInputFingerprint !== rescheduleReceiptIdentity(input)) throw conflict('The idempotency key belongs to different reschedule details.', 'RESCHEDULE_IDEMPOTENCY_CONFLICT');
  if (replacement?.rescheduledFrom && String(replacement.rescheduledFrom) !== String(original._id)) {
    throw conflict('The idempotency key belongs to a different reschedule operation.', 'RESCHEDULE_IDEMPOTENCY_CONFLICT');
  }
  return { original, replacement, key };
}

/** Decide replay without provider access.
 * @param {{business:BusinessScope, original:AppointmentRecord, replacement:AppointmentRecord|null}} input
 * @returns {Promise<{appointment:object|null}>} */
export async function findCompletedReschedule({ business, original, replacement }, { Appointment }) {
  if (replacement?.status === 'confirmed') return { appointment: replacement };
  if (replacement && replacement.status !== 'held') {
    throw conflict(`The prior reschedule operation cannot be replayed from state "${replacement.status}".`, 'RESCHEDULE_IDEMPOTENCY_FINAL_STATE');
  }
  if (original.status !== 'rescheduled') return { appointment: null };
  const existing = original.rescheduledTo && await Appointment.findOne({ _id: original.rescheduledTo, business: business._id });
  if (!existing) throw conflict('The appointment was already rescheduled but its replacement could not be resolved.', 'RESCHEDULE_REPLACEMENT_NOT_FOUND');
  // A legacy lost acknowledgement can leave a staged held replacement here.
  if (existing.status === 'held' && existing.pendingRescheduleExternalAppointmentId &&
      String(existing._id) === String(replacement?._id)) return { appointment: null };
  return { appointment: existing };
}

function replacementInput(original, input, service) {
  return { ...input, serviceOfferingId: service._id, lead: original.lead, conversation: original.conversation,
    customerName: input.customerName || original.customerName, customerPhone: input.customerPhone || original.customerPhone,
    customerEmail: input.customerEmail || original.customerEmail, address: input.address || original.address,
    timezone: input.timezone || original.timezone, source: input.source || original.source,
    bookedBy: input.bookedBy || original.bookedBy, estimatedValue: original.estimatedValue, notes: input.notes || original.notes };
}

/** Read service/policy; hold persistence belongs to finalize.
 * @param {{business:BusinessScope, original:AppointmentRecord, replacement:AppointmentRecord|null, input:import('./types.js').RescheduleInput}} input
 * @returns {Promise<{service:import('./types.js').Service, nextInput:object}>} */
export async function prepareReschedule({ business, original, replacement, input }, { assertTransition, getBookableService, exactSlotAvailable, addMinutes }) {
  if (original.status !== 'rescheduled') assertTransition(original.status, 'rescheduled');
  const service = await getBookableService({ businessId: business._id, serviceOfferingId: original.serviceOffering });
  const nextInput = replacementInput(original, input, service);
  if (!replacement && !await exactSlotAvailable({ business, serviceOfferingId: service._id,
    startAt: nextInput.startAt, endAt: nextInput.endAt || addMinutes(nextInput.startAt, service.durationMinutes),
    postalCode: nextInput.address?.postalCode, excludeAppointmentId: original._id })) {
    throw conflict('The requested replacement time is unavailable.', 'SLOT_UNAVAILABLE');
  }
  return { service, nextInput };
}
