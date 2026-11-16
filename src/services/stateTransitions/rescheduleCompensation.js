export const queueRescheduleCompensation = ({ Appointment, replacement, receipt }) => Appointment.findOneAndUpdate({
  _id: replacement._id, business: replacement.business, status: { $in: ['held', 'confirmed'] },
  rescheduledFrom: replacement.rescheduledFrom,
}, { $set: { status: 'canceled', failureReason: 'Original appointment changed during rescheduling.',
  lifecycleNotice: { pending: false }, providerCompensation: { pending: true,
    eventId: receipt.externalAppointmentId || null, calendarId: receipt.externalCalendarId || null,
    provider: receipt.provider, nextAttemptAt: new Date(), lastError: '' } } }, { returnDocument: 'after' });
export const claimRescheduleCompensation = ({ Appointment, id, token, now }) => Appointment.findOneAndUpdate({
  _id: id, 'providerCompensation.pending': true, 'providerCompensation.nextAttemptAt': { $lte: now },
  $or: [{ 'providerCompensation.leaseUntil': { $exists: false } }, { 'providerCompensation.leaseUntil': { $lte: now } }],
}, { $set: { 'providerCompensation.token': token, 'providerCompensation.leaseUntil': new Date(+now + 120000) } }, { returnDocument: 'after' });
export const finishRescheduleCompensation = ({ Appointment, appointment, token }) => Appointment.updateOne({
  _id: appointment._id, business: appointment.business, 'providerCompensation.token': token,
}, { $set: { 'providerCompensation.pending': false, activeSlotKey: null, slotClaimKeys: [], capacityLane: null,
  pendingRescheduleExternalAppointmentId: null, pendingRescheduleExternalCalendarId: null,
  externalAppointmentId: null, externalCalendarId: null }, $unset: { 'providerCompensation.token': '', 'providerCompensation.leaseUntil': '' } });
export const retryRescheduleCompensation = ({ Appointment, appointment, token, error }) => Appointment.updateOne({
  _id: appointment._id, business: appointment.business, 'providerCompensation.token': token,
}, { $set: { 'providerCompensation.lastError': String(error.message).slice(0, 300),
  'providerCompensation.nextAttemptAt': new Date(Date.now() + 60000) },
$unset: { 'providerCompensation.token': '', 'providerCompensation.leaseUntil': '' } });
