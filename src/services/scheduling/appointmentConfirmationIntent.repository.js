import { randomUUID } from 'node:crypto';

export const confirmationPending = () => Object.assign(
  new Error('Appointment confirmation is already being processed. Refresh the appointment before taking another action.'),
  { statusCode: 409, code: 'APPOINTMENT_CONFIRMATION_PENDING' },
);

export function assertConfirmationNotPending(appointment) {
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
    Appointment.findOneAndUpdate(owned(appointment), { $set: fields }, options).select("+confirmationIntent");

  return {
    async begin(appointment, approvedBy, provider) {
      const now = clock();
      return Appointment.findOneAndUpdate({
        ...slotIdentity(appointment),
        status: 'held',
        $or: [{ heldExpiresAt: null }, { heldExpiresAt: { $gt: now } }],
        'confirmationIntent.status': { $ne: 'pending_provider' },
        ...(appointment.updatedAt ? { updatedAt: appointment.updatedAt } : {}),
      }, { $set: { confirmationIntent: {
        key: `${appointment.business}:${appointment._id}`,
        status: 'pending_provider',
        requestedAt: now,
        nextAttemptAt: now,
        approvedBy,
        provider,
        attempts: 0,
        ...lease(now),
      } } }, options).select("+confirmationIntent");
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
      return Appointment.findOneAndUpdate({
        ...slotIdentity(appointment),
        status: appointment.status,
        'confirmationIntent.status': appointment.confirmationIntent.status,
        ...due(now),
      }, { $set: { 'confirmationIntent.token': token, 'confirmationIntent.leaseUntil': leaseUntil } }, options).select("+confirmationIntent");
    },

    patch,
    getCommitted(appointment) {
      return Appointment.findOne({ ...slotIdentity(appointment), status: 'confirmed',
        'confirmationIntent.key': appointment.confirmationIntent.key }).select("+confirmationIntent").read('primary').readConcern('majority');
    },
    finishEffects(appointment) {
      return Appointment.findOneAndUpdate(owned(appointment), {
        $set: { 'confirmationIntent.effectsPending': false },
        $unset: { 'confirmationIntent.nextAttemptAt': '', 'confirmationIntent.token': '', 'confirmationIntent.leaseUntil': '' },
      }, options).select("+confirmationIntent");
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
