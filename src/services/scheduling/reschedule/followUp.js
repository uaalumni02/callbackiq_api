/** @typedef {import('./types.js').AppointmentRecord} AppointmentRecord */
/** @typedef {import('./types.js').BusinessScope} BusinessScope */
/** Idempotent persisted effects; provider sends remain owned by notification jobs.
 * @param {{business:BusinessScope, original:AppointmentRecord, replacement:AppointmentRecord}} input
 * @returns {Promise<{appointment:AppointmentRecord}>} */
export async function followUp({ business, original, replacement }, {
  Lead, cancelAppointmentNotifications, scheduleAppointmentReminders, tryRepairAppointmentLifecycle,
  runNonBlockingAppointmentSideEffect, SocketService,
}) {
  await tryRepairAppointmentLifecycle(replacement, business, { repairMissingOnly: true });
  await runNonBlockingAppointmentSideEffect({ appointment: original, businessId: business._id,
    label: 'reschedule reminder cleanup', task: () => cancelAppointmentNotifications({
      businessId: business._id, appointmentId: original._id, reason: 'Appointment rescheduled.' }) });
  await runNonBlockingAppointmentSideEffect({ appointment: replacement, businessId: business._id,
    label: 'rescheduled appointment reminder scheduling',
    task: () => scheduleAppointmentReminders({ appointment: replacement, repairMissingOnly: true }) });
  if (replacement.lead) await runNonBlockingAppointmentSideEffect({ appointment: replacement, businessId: business._id,
    label: 'rescheduled lead linkage', task: () => Lead.updateOne({ _id: replacement.lead, business: business._id },
      { $set: { appointment: replacement._id, bookedAt: replacement.confirmedAt } }) });
  SocketService.emitToBusiness(business._id, 'appointment:rescheduled', { original, replacement });
  SocketService.emitDashboardRefresh(business._id, 'appointment_rescheduled');
  return { appointment: replacement };
}
