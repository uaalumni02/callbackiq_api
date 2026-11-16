import crypto from 'node:crypto';
import { queueRescheduleCompensation, claimRescheduleCompensation, finishRescheduleCompensation, retryRescheduleCompensation } from '../../stateTransitions/rescheduleCompensation.js';
export async function repairCompensation({ Appointment, appointmentId, provider }) {
  const token = crypto.randomUUID();
  const appointment = await claimRescheduleCompensation({ Appointment, id: appointmentId, token, now: new Date() });
  if (!appointment) return;
  try {
    const receipt = appointment.providerCompensation;
    if (receipt.eventId) await provider.cancelAppointment({ appointment: { ...appointment.toObject(),
      externalAppointmentId: receipt.eventId, externalCalendarId: receipt.calendarId }, reason: 'Superseded reschedule compensation.' });
    await finishRescheduleCompensation({ Appointment, appointment, token });
  } catch (error) { await retryRescheduleCompensation({ Appointment, appointment, token, error }); }
}
export async function compensateSuperseded(input, { Appointment, provider }) {
  if (!provider || !input.handoff?.applied) return false;
  const current = await Appointment.findOne({ _id: input.original._id, business: input.business._id }).lean();
  if (!current || !['canceled', 'completed', 'no_show', 'failed'].includes(current.status)) return false;
  const appointment = await queueRescheduleCompensation({ Appointment, replacement: input.replacement, receipt: input.handoff.receipt });
  if (appointment) await repairCompensation({ Appointment, appointmentId: appointment._id, provider });
  return true;
}
