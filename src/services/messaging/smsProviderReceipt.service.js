import mongoose from 'mongoose';
import Reservation from '../../models/communicationUsageReservation.js';
import { normalizeSmsPhone } from './smsCompliance.service.js';

// Only call this from a signature-verified status webhook or its durable
// replay. The callback reference is included in Twilio's signed URL.
export async function reconcileSmsProviderReceipt({ businessId, reservationId, ownerToken, payload = {} }) {
  if (!mongoose.isValidObjectId(businessId) || !mongoose.isValidObjectId(reservationId)) return null;
  if (typeof ownerToken !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerToken)) return null;
  const sid = String(payload.MessageSid || payload.SmsSid || '').trim();
  const to = normalizeSmsPhone(payload.To);
  if (!/^SM[0-9a-f]{32}$/i.test(sid) || !to) return null;
  return Reservation.findOneAndUpdate({
    _id: reservationId, business: businessId, ownerToken, metric: 'sms_outbound',
    state: { $in: ['pending', 'uncertain'] }, providerDispatchStartedAt: { $type: 'date' },
    'metadata.providerRequest.to': to,
    providerOperationId: { $in: ['', sid] },
  }, { $set: {
    state: 'committed', providerOperationId: sid,
    providerStatus: String(payload.MessageStatus || payload.SmsStatus || 'accepted').slice(0, 40),
    committedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 30 * 86400000),
  } }, { returnDocument: 'after' });
}
