/** @typedef {import('./types.js').AppointmentRecord} AppointmentRecord */
/** @typedef {import('./types.js').BusinessScope} BusinessScope */
/** @typedef {{provider:string, externalAppointmentId:string|null, externalCalendarId:string|null}} ProviderReceipt */
/** The only provider mutation; no database writes.
 * @param {{original:AppointmentRecord, replacement:AppointmentRecord, service:import('./types.js').Service}} input
 * @param {{provider:{updateAppointment:(input:object)=>Promise<ProviderReceipt>}}} dependencies
 * @returns {Promise<import('./types.js').HandoffResult>} */
export async function providerHandoff({ original, replacement, service }, { provider }) {
  const resumed = replacement.status === 'held' && !original.externalAppointmentId &&
    Boolean(replacement.pendingRescheduleExternalAppointmentId);
  if (resumed) return { applied: true, resumed: true, receipt: {
    provider: replacement.provider || original.provider || 'internal',
    externalAppointmentId: replacement.pendingRescheduleExternalAppointmentId,
    externalCalendarId: replacement.pendingRescheduleExternalCalendarId || null,
  } };
  const result = await provider.updateAppointment({ appointment: original, eventAppointment: replacement,
    changes: { startAt: replacement.startAt, endAt: replacement.endAt }, service });
  return { applied: true, resumed: false, receipt: {
    provider: result?.provider || replacement.provider || original.provider || 'internal',
    externalAppointmentId: result?.externalAppointmentId || replacement.pendingRescheduleExternalAppointmentId ||
      replacement.externalAppointmentId || original.externalAppointmentId || null,
    externalCalendarId: result?.externalCalendarId || replacement.pendingRescheduleExternalCalendarId ||
      replacement.externalCalendarId || original.externalCalendarId || null,
  } };
}
