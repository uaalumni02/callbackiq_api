import CallLog from '../models/callLog.js';
import SocketService from './socket.service.js';

export async function recordCallAnswer({ businessId, callLogId, answeredBy, now = new Date() }) {
  if (!businessId || !callLogId || !['ai', 'business'].includes(answeredBy)) return null;
  const filter = { _id: callLogId, business: businessId };
  if (answeredBy === 'ai') filter.disposition = { $ne: 'answered_by_business' };
  const call = await CallLog.findOneAndUpdate(filter, {
    $set: { disposition: `answered_by_${answeredBy}`, ...(answeredBy === 'business' ? { status: 'answered', answeredAt: now } : {}) },
  }, { returnDocument: 'after' });
  if (call && typeof SocketService.emitCallUpdated === 'function') SocketService.emitCallUpdated(businessId, call);
  return call;
}
