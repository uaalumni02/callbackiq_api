import crypto from 'node:crypto';
import Appointment from '../../models/appointment.js';
import Lead from '../../models/lead.js';
import ServiceOffering from '../../models/serviceOffering.js';
import Alert from '../../models/alert.js';
import AlertService from '../alert.service.js';
import ConversionEventService from '../conversionEvent.service.js';
import InterventionService from '../intervention.service.js';
import { withDistributedLease, assertDistributedLeaseActive } from '../distributedLease.service.js';
import { schedulePostAppointmentFollowUp } from './appointmentNotification.service.js';
import { safeConsole } from '../../helpers/logging/safeLogger.js';

export const projectionMarker = () => ({ token: crypto.randomUUID(), pending: true,
  at: new Date(), retryAt: new Date(), lastError: '' });
const fields = ['bookingProjection', 'completionProjection'];
const scoped = (appointment, field) => ({ _id: appointment._id, business: appointment.business,
  status: appointment.status, [`${field}.token`]: appointment[field].token, [`${field}.pending`]: true });

async function repairOne(appointment, field) {
  const marker = appointment[field];
  if (!marker?.pending) return;
  if (field === 'bookingProjection' && !['confirmed', 'completed'].includes(appointment.status)) {
    // A cancelled/replaced visit must not be restored to the lead on retry.
    if (appointment.lead) await Lead.updateOne({ _id: appointment.lead, business: appointment.business, appointment: appointment._id }, { $set: { appointment: null } });
  } else if (field === 'bookingProjection') {
    const [lead, service] = await Promise.all([
      appointment.lead ? Lead.findOne({ _id: appointment.lead, business: appointment.business }) : null,
      ServiceOffering.findOne({ _id: appointment.serviceOffering, business: appointment.business }),
    ]);
    assertDistributedLeaseActive();
    await ConversionEventService.markAppointmentBooked({ appointment, lead,
      channel: appointment.source, bookedBy: appointment.bookedBy });
    assertDistributedLeaseActive();
    if (appointment.lead) await AlertService.createBookedJobAlert({
      businessId: appointment.business, leadId: appointment.lead, appointmentId: appointment._id, strict: true,
      customerName: appointment.customerName, customerPhone: appointment.customerPhone,
      serviceNeeded: service?.name || lead?.serviceNeeded || 'Service appointment', estimatedValue: appointment.estimatedValue,
    });
  } else {
    if (appointment.status !== 'completed') return;
    await ConversionEventService.record({ businessId: appointment.business, leadId: appointment.lead,
      conversationId: appointment.conversation, appointmentId: appointment._id, type: 'job_completed',
      channel: appointment.source, estimatedValue: appointment.estimatedValue, actualRevenue: appointment.actualRevenue,
      marketingSourceId: appointment.marketingSource || null, trackingNumberId: appointment.trackingNumber || null,
      attribution: appointment.attribution || {}, occurredAt: appointment.completedAt,
      idempotencyKey: `job_completed:${appointment._id}` });
    assertDistributedLeaseActive();
    if (appointment.lead) await Lead.updateOne({ _id: appointment.lead, business: appointment.business,
      $or: [{ completionProjectionAt: null }, { completionProjectionAt: { $lte: marker.at } }],
    }, { $set: { completedAt: appointment.completedAt, actualRevenue: appointment.actualRevenue,
      completionProjectionAt: marker.at } });
    assertDistributedLeaseActive();
    await schedulePostAppointmentFollowUp({ appointment });
  }
  assertDistributedLeaseActive();
  // A correction saved during repair has a new token. Never erase its obligation.
  await Alert.updateMany({ business: appointment.business, dedupeKey: `appointment_projection:${appointment._id}:${field}:${marker.token}`, resolvedAt: null },
    { $set: { resolvedAt: new Date(), actionRequired: false } });
  const result = await Appointment.updateOne(scoped(appointment, field), {
    $set: { [`${field}.pending`]: false, [`${field}.lastError`]: '' },
  });
  if (result.matchedCount === 1) { marker.pending = false; marker.lastError = ''; }

}

// Both the request and background repair use the existing database lease. All
// writes are idempotent; the marker is committed in the appointment's own save.
export async function tryRepairAppointmentProjections(appointment) {
  if (!fields.some(field => appointment[field]?.pending)) return;
  const response = appointment;
  try {
    await withDistributedLease(`appointment-projection:${appointment.business}:${appointment._id}`, async () => {
      const fresh = await Appointment.findOne({ _id: appointment._id, business: appointment.business });
      if (!fresh) return;
      appointment = fresh;
      for (const field of fields) {
        if (!appointment[field]?.pending) continue;
        try { await repairOne(appointment, field); }
        catch (error) {
          const lastError = String(error.message || 'Projection repair failed').slice(0, 300);
          appointment[field].lastError = lastError;
          await Appointment.updateOne(scoped(appointment, field), { $set: {
            [`${field}.lastError`]: lastError, [`${field}.retryAt`]: new Date(Date.now() + 60000),
          } }).catch(() => {});
          await InterventionService.create({ businessId: appointment.business, appointmentId: appointment._id,
            leadId: appointment.lead, conversationId: appointment.conversation, type: 'integration_failure',
            title: 'Saved appointment records are still updating',
            message: 'The appointment outcome is saved. Related records need an automatic retry.',
            reason: lastError, recommendedAction: 'Check this appointment again after the automatic retry.',
            dedupeKey: `appointment_projection:${appointment._id}:${field}:${appointment[field].token}`,
          }).catch(() => {});
          safeConsole.error('Appointment projection repair pending', { appointmentId: String(appointment._id), field });
        }
      }
      for (const field of fields) if (response[field]?.token === appointment[field]?.token) response[field] = appointment[field];
    });
  } catch (error) {
    // Lease/database failure cannot make a committed appointment look unsaved.
    safeConsole.error('Appointment projection lease unavailable', { appointmentId: String(appointment._id), error: error.message });
  }
}

export async function repairPendingAppointmentProjections({ businessId = null, limit = 100, now = new Date() } = {}) {
  const rows = await Appointment.find({ ...(businessId ? { business: businessId } : {}),
    $or: fields.map(field => ({ [`${field}.pending`]: true, [`${field}.retryAt`]: { $lte: now } })),
  }).sort({ updatedAt: 1, _id: 1 }).limit(limit).lean();
  for (const row of rows) await tryRepairAppointmentProjections(row);
}
