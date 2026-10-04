import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Message from '../../models/message.js';
import Appointment from '../../models/appointment.js';
import AppointmentNotificationJob from '../../models/appointmentNotificationJob.js';
import normalizePhone from '../../helpers/normalizePhone.js';

// Internal classification only. Caller flags and category labels are not proof.
// The existing durable operation key remains the authority for replay/concurrency.
export async function resolveSmsUsageClass({ businessId, to, from, conversationId,
  directResponse, source, metadata = {}, operationKey, body }) {
  const inboundId = metadata.inboundMessageId;
  if (directResponse && mongoose.isObjectIdOrHexString(inboundId) &&
      operationKey === `sms-inbound-reply:${businessId}:${new mongoose.Types.ObjectId(inboundId).toHexString()}`) {
    const inbound = await Message.findOne({ _id: inboundId, business: businessId,
      conversation: conversationId, direction: 'inbound', provider: 'twilio',
      from: normalizePhone(to), to: normalizePhone(from), status: 'received' }).select('_id').lean();
    if (inbound) return 'reply';
  }
  const jobId = metadata.appointmentNotificationJobId;
  const appointmentId = metadata.appointmentId;
  if (source === 'appointment_change_notice' && mongoose.isObjectIdOrHexString(jobId) &&
      mongoose.isObjectIdOrHexString(appointmentId)) {
    const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 32);
    if (operationKey !== `appointment-notice:${businessId}:${new mongoose.Types.ObjectId(jobId).toHexString()}:${hash}`) return 'proactive';
    const job = await AppointmentNotificationJob.findOne({ _id: jobId, business: businessId,
      appointment: appointmentId, type: 'change_notice', status: 'processing',
      key: metadata.appointmentNotificationKey, body }).select('_id').lean();
    if (job && await Appointment.exists({ _id: appointmentId, business: businessId,
      customerPhone: normalizePhone(to) })) return 'appointment';
  }
  return 'proactive';
}
