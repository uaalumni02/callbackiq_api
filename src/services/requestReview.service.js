import crypto from 'node:crypto';
import Alert from '../models/alert.js';
import Conversation from '../models/conversation.js';
import Message from '../models/message.js';
import SocketService from './socket.service.js';

export const requestReviewKey = (conversationId, journey = '') =>
  `request_review:${conversationId}:${crypto.createHash('sha256').update(String(journey)).digest('hex').slice(0, 24)}`;

// Safety, delivery, and other exceptions retain their own lifecycle.
export const isRequestReview = payload => payload.type === 'human_requested' &&
  payload.conversationId && /^(ai_review|human_handoff):/.test(payload.dedupeKey || '');

export async function saveRequestReview(payload, create) {
  const conversation = await Conversation.findOne({ _id: payload.conversationId, business: payload.businessId })
    .select('orchestration').lean();
  if (!conversation) throw new Error('Cannot save a staff review without its scoped conversation');
  const journey = conversation.orchestration?.recoveryJourneyKey || '';
  const key = requestReviewKey(payload.conversationId, journey);
  const eventKey = payload.dedupeKey;
  const inbound = payload.metadata?.messageId ? await Message.findOne({
    _id: payload.metadata.messageId, business: payload.businessId, conversation: payload.conversationId,
  }).select('createdAt').lean() : null;
  // Persisted source time is stable on retries. Sources without a message use
  // the canonical record's creation time below, never a changing retry time.
  const result = await create({ ...payload, dedupeKey: key,
    metadata: { ...payload.metadata, reviewJourneyKey: journey, requestReview: true } });
  if (!result.alert?._id) throw new Error('Staff review was not persisted');
  const occurredAt = new Date(inbound?.createdAt || result.alert.createdAt);
  const phase = payload.metadata?.intakeReview ? 2 : 1;
  const scope = { _id: result.alert._id, business: payload.businessId };
  const event = { key: eventKey, occurredAt, title: payload.title, message: payload.message,
    messageId: payload.metadata?.messageId || null, providerMessageId: payload.metadata?.providerMessageId || null,
    handoffReason: payload.metadata?.handoffReason || '', priority: payload.priority };
  // One atomic append per source event, including retries after a process crash.
  await Alert.updateOne({ ...scope, 'reviewEvents.key': { $ne: eventKey } }, { $push: { reviewEvents: event } });
  const set = { title: payload.title, message: payload.message, reason: payload.reason,
    recommendedAction: payload.recommendedAction, lastCustomerMessage: payload.lastCustomerMessage,
    reviewLatestAt: occurredAt, reviewPhase: phase };
  if (payload.aiSummary) set.aiSummary = payload.aiSummary;
  for (const [name, value] of Object.entries(payload.metadata || {})) {
    if (value !== undefined && value !== null) set[`metadata.${name}`] = value;
  }
  // An older retry cannot erase newer facts or turn a ready intake back into
  // an initial urgency alert. Ownership, acknowledgement, resolution and SLA
  // are intentionally absent from this update.
  await Alert.updateOne({ ...scope, resolvedAt: null, $and: [
    { $or: [{ reviewLatestAt: null }, { reviewLatestAt: { $lte: occurredAt } }] },
    { $or: [{ reviewPhase: null }, { reviewPhase: { $lte: phase } }] },
  ] }, { $set: set });
  const ranks = ['low', 'medium', 'high', 'critical'];
  await Alert.updateOne({ ...scope, resolvedAt: null, priority: { $in: ranks.slice(0, ranks.indexOf(payload.priority)) } },
    { $set: { priority: payload.priority } });
  const alert = await Alert.findOne(scope).populate('business', 'businessName businessType phone')
    .populate('lead', 'customerName phone serviceNeeded urgency status').lean();
  SocketService.emitAlertUpdated(payload.businessId, alert);
  return { alert, created: result.created };
}
