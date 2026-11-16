import { patchOwnedConfirmationIntent, beginConfirmationIntent, claimDueConfirmationIntent, finishConfirmationEffects } from '../stateTransitions/appointmentLifecycle.js';
import { randomUUID } from 'node:crypto';
export const confirmationPending = () => Object.assign(
  new Error('Appointment confirmation is already being processed. Refresh the appointment before taking another action.'),
  { statusCode: 409, code: 'APPOINTMENT_CONFIRMATION_PENDING' },
);

export function assertConfirmationNotPending(appointment) {
  if (appointment.rescheduleIntent?.key) throw Object.assign(new Error('A reschedule is pending. Retry that operation before changing the appointment.'), { statusCode: 409, code: 'APPOINTMENT_RESCHEDULE_PENDING' });
  if (appointment.confirmationIntent?.status === 'pending_provider') throw confirmationPending();
}

const slotIdentity = (appointment) => ({
  _id: appointment._id,
  business: appointment.business,
});

const due = (now) => ({
  'confirmationIntent.nextAttemptAt': { $lte: now },
  'confirmationIntent.leaseUntil': { $lte: now },
});

const majority = { w: 'majority' };
const options = { returnDocument: 'after', runValidators: true, writeConcern: majority };

export function createConfirmationIntentRepository({ Appointment, leaseMs = 120_000, clock = () => new Date() }) {
  const lease = (now) => ({
    token: randomUUID(),
    leaseUntil: new Date(now.getTime() + leaseMs),
  });
  const owned = (appointment) => ({
    ...slotIdentity(appointment),
    status: appointment.status,
    'confirmationIntent.key': appointment.confirmationIntent.key,
    'confirmationIntent.status': appointment.confirmationIntent.status,
    'confirmationIntent.token': appointment.confirmationIntent.token,
    'confirmationIntent.leaseUntil': { $gt: clock() },
  });
  const patch = (appointment, fields) =>
    patchOwnedConfirmationIntent({ Appointment, appointment, fields, options, owned }).select("+confirmationIntent");

  return {
    async begin(appointment, approvedBy, provider) {
      const now = clock();
      return beginConfirmationIntent({ Appointment, appointment, approvedBy, lease, now, options, provider, slotIdentity }).select("+confirmationIntent");
    },

    listDue(limit) {
      const now = clock();
      return Appointment.find({ ...due(now), $or: [
        { status: 'held', 'confirmationIntent.status': 'pending_provider' },
        { status: { $in: ['confirmed', 'failed'] }, 'confirmationIntent.effectsPending': true },
      ] }).sort({ 'confirmationIntent.nextAttemptAt': 1, _id: 1 }).limit(limit).select("+confirmationIntent").lean();
    },

    claim(appointment) {
      const now = clock();
      const { token, leaseUntil } = lease(now);
      return claimDueConfirmationIntent({ Appointment, appointment, due, leaseUntil, now, options, slotIdentity, token }).select("+confirmationIntent");
    },

    patch,
    getCommitted(appointment) {
      return Appointment.findOne({ ...slotIdentity(appointment), status: 'confirmed',
        'confirmationIntent.key': appointment.confirmationIntent.key }).select("+confirmationIntent").read('primary').readConcern('majority');
    },
    finishEffects(appointment) {
      return finishConfirmationEffects({ Appointment, appointment, options, owned }).select("+confirmationIntent");
    },
    defer(appointment, delayMs) {
      const now = clock();
      return patch(appointment, {
        'confirmationIntent.leaseUntil': now,
        'confirmationIntent.nextAttemptAt': new Date(now.getTime() + delayMs),
      });
    },
  };
}
