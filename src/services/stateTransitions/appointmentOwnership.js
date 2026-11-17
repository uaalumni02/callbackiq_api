import crypto from 'node:crypto';
export const appointmentConflict = () => Object.assign(new Error('The appointment changed or another operation owns it. Reload before trying again.'), {
  statusCode: 409, code: 'APPOINTMENT_STATE_CONFLICT',
});
// Claim before any external DELETE. A pending intent survives errors and worker crashes.
export async function claimAppointmentCancellation({ Appointment, appointment, reason, notifyCustomer }) {
  const now = new Date(), token = crypto.randomUUID();
  const pending = appointment.status === 'cancel_pending';
  if (!pending && !['held', 'confirmed'].includes(appointment.status)) throw appointmentConflict();
  const claimed = await Appointment.findOneAndUpdate({
    _id: appointment._id, business: appointment.business, status: appointment.status,
    stateVersion: appointment.stateVersion || { $in: [0, null] },
    ...(appointment.updatedAt ? { updatedAt: appointment.updatedAt } : {}),
    'rescheduleIntent.key': { $exists: false },
    'confirmationIntent.status': { $ne: 'pending_provider' },
    ...(pending ? { 'cancellationIntent.leaseUntil': { $lte: now } } : {}),
  }, { $set: { status: 'cancel_pending', cancellationIntent: {
    key: `cancel:${appointment._id}`, token, leaseUntil: new Date(+now + 120000), nextAttemptAt: now,
    attempts: (appointment.cancellationIntent?.attempts || 0) + 1,
    reason: pending ? appointment.cancellationIntent.reason : String(reason).slice(0, 1000),
    notifyCustomer: pending ? appointment.cancellationIntent.notifyCustomer : notifyCustomer,
  } } }, { returnDocument: 'after', runValidators: true }).select('+confirmationIntent');
  if (!claimed) throw appointmentConflict();
  return claimed;
}

export function deferAppointmentCancellation({ Appointment, appointment, error }) {
  return Appointment.updateOne({ _id: appointment._id, business: appointment.business,
    status: 'cancel_pending', 'cancellationIntent.token': appointment.cancellationIntent.token,
  }, { $set: { 'cancellationIntent.leaseUntil': new Date(),
    'cancellationIntent.nextAttemptAt': new Date(Date.now() + 60000),
    'cancellationIntent.lastError': String(error.code || error.name || 'PROVIDER_OUTCOME_UNCERTAIN').slice(0, 160) } });
}
/** Durable original-appointment ownership survives a worker crash. Only same-key replay may resume. */
export async function claimRescheduleOriginal({ Appointment, original, business, key, input }) {
  if (original.status === 'rescheduled') return original;
  const fingerprint = rescheduleReceiptIdentity(input);
  const now = new Date(), token = crypto.randomUUID();
  if (original.rescheduleIntent?.fingerprint && original.rescheduleIntent.fingerprint !== fingerprint) throw appointmentConflict();
  const claimed = await Appointment.findOneAndUpdate({
    _id: original._id, business: business._id, status: 'confirmed',
    stateVersion: original.stateVersion || { $in: [0, null] },
    ...(original.updatedAt ? { updatedAt: original.updatedAt } : {}),
    $and: [
      { $or: [{ 'rescheduleIntent.key': key }, { 'rescheduleIntent.key': { $exists: false } }, { rescheduleIntent: null }] },
      { $or: [{ 'rescheduleIntent.leaseUntil': { $exists: false } }, { 'rescheduleIntent.leaseUntil': { $lte: now } }] },
    ],
    'confirmationIntent.status': { $ne: 'pending_provider' },
  }, { $set: { rescheduleIntent: { key, fingerprint, startedAt: now, leaseToken: token, leaseUntil: new Date(+now + 120000) } } },
  { returnDocument: 'after', runValidators: true }).select('+confirmationIntent');
  if (!claimed) throw appointmentConflict();
  claimed.$locals.rescheduleOperationKey = key;
  claimed.$locals.rescheduleLeaseToken = token;
  return claimed;
}
/** Release only this invocation's lease; pre-provider reservation failure may abandon the intent. */
export async function releaseRescheduleOriginal({ Appointment, original, abandon = false }) {
  return Appointment.updateOne({ _id: original._id, business: original.business, status: 'confirmed',
    'rescheduleIntent.key': original.$locals.rescheduleOperationKey,
    'rescheduleIntent.leaseToken': original.$locals.rescheduleLeaseToken,
  }, { $unset: abandon ? { rescheduleIntent: '' } : { 'rescheduleIntent.leaseToken': '', 'rescheduleIntent.leaseUntil': '' } });
}
/** Every loaded appointment save is fenced against a newer status or timestamp. */
export function installAppointmentOwnership(schema) {
  const remember = doc => {
    doc.$locals.observedStatus = doc.status;
    doc.$locals.observedBusiness = doc.business?._id || doc.business;
    doc.$locals.observedUpdatedAt = doc.updatedAt;
    doc.$locals.observedStateVersion = doc.stateVersion || 0;
    doc.$where = doc.$locals.ownershipPreviousWhere;
    delete doc.$locals.ownershipPreviousWhere;
  };
  schema.post('init', remember);
  schema.post('save', remember);
  schema.post('save', function (error, doc, next) {
    doc.$where = doc.$locals.ownershipPreviousWhere; delete doc.$locals.ownershipPreviousWhere; next(error);
  });
  for (const method of ['updateOne', 'updateMany', 'findOneAndUpdate']) schema.pre(method, function () {
    const update = this.getUpdate();
    if (Array.isArray(update)) update.push({ $set: { stateVersion: { $add: [{ $ifNull: ['$stateVersion', 0] }, 1] } } });
    else {
      if (update.$set && Object.hasOwn(update.$set, 'stateVersion')) throw appointmentConflict();
      update.$inc = { ...update.$inc, stateVersion: 1 };
    }
  });
  schema.pre('save', function () {
    if (this.isNew) return;
    if (String(this.$locals.observedBusiness) !== String(this.business?._id || this.business)) throw appointmentConflict();
    const claim = { business: this.$locals.observedBusiness, status: this.$locals.observedStatus,
      $or: [{ stateVersion: this.$locals.observedStateVersion || 0 }, { stateVersion: { $exists: false } }] };
    this.stateVersion = (this.$locals.observedStateVersion || 0) + 1;
    if (this.$locals.observedUpdatedAt) claim.updatedAt = this.$locals.observedUpdatedAt;
    if (this.rescheduleIntent?.key) {
      if (this.$locals.rescheduleOperationKey !== this.rescheduleIntent.key) throw appointmentConflict();
      claim['rescheduleIntent.key'] = this.rescheduleIntent.key;
      if (this.$locals.rescheduleLeaseToken) claim['rescheduleIntent.leaseToken'] = this.$locals.rescheduleLeaseToken;
    }
    this.$locals.ownershipPreviousWhere = this.$where;
    this.$where = { $and: [this.$where || {}, claim] };
  });
}
export function rescheduleReceiptIdentity(input) {
  const canonical = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).filter(k => k !== 'idempotencyKey').sort().map(k => [k, canonical(value[k])])) : value;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}
