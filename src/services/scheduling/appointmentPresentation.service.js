import AppointmentNotificationJob from '../../models/appointmentNotificationJob.js';
import Message from '../../models/message.js';
import { queryBudgetMs } from '../scale/queryBudget.js';
import { confirmationNoticeState } from './appointmentConfirmationState.js';
import { logOperationalError } from '../../helpers/logging/safeLogger.js';

const id = value => String(value?._id || value || '');
const plain = value => value?.toObject?.() || value;

// One bounded batch per page, never a per-row query. State is read from the
// linked notice/receipt, not inferred from a confirmed appointment.
export async function presentAppointments(appointments, businessId) {
  if (!appointments.length) return [];
  try {
    const jobs = await AppointmentNotificationJob.find({ business: businessId,
      appointment: { $in: appointments.map(row => row._id) }, key: 'change_notice:business_approval_confirmed',
    }).select('appointment status providerMessageId sentAt failureReason').maxTimeMS(queryBudgetMs()).lean();
    const receipts = jobs.map(job => job.providerMessageId).filter(Boolean);
    const messages = receipts.length ? await Message.find({ business: businessId, direction: 'outbound',
      provider: 'twilio', providerMessageId: { $in: receipts },
    }).select('providerMessageId deliveryStatus deliveryUncertain status').maxTimeMS(queryBudgetMs()).lean() : [];
    const byAppointment = new Map(jobs.map(job => [id(job.appointment), job]));
    const byReceipt = new Map(messages.map(message => [message.providerMessageId, message]));
    return appointments.map(row => {
      const appointment = plain(row), job = byAppointment.get(id(row));
      const receipt = job && byReceipt.get(job.providerMessageId);
      const notice = confirmationNoticeState(appointment, job, receipt);
      return { ...appointment, confirmationNotice: notice, confirmationNoticeStatus: notice.status };
    });
  } catch (error) {
    // A completed mutation must not appear to fail merely because its readback
    // could not verify delivery. Explicitly expose unavailable evidence.
    logOperationalError('appointment.delivery_read_failed', error, { businessId });
    return appointments.map(row => ({ ...plain(row), confirmationNoticeStatus: 'unavailable',
      confirmationNotice: { status: 'unavailable', deliveryStatus: 'unverified' } }));
  }
}

export async function presentAppointment(appointment, businessId) {
  return appointment ? (await presentAppointments([appointment], businessId))[0] : null;
}
