import mongoose from 'mongoose';
import Conversation from '../../models/conversation.js';
import Message from '../../models/message.js';
import CallLog from '../../models/callLog.js';
import Appointment from '../../models/appointment.js';
import VoiceSession from '../../models/voiceSession.js';
import Alert from '../../models/alert.js';
import Intelligence from '../../models/conversationIntelligence.js';
import ConversionEvent from '../../models/conversionEvent.js';
import { verifiedAmountExpression } from '../valuation/opportunityValue.js';
import { deriveCanonicalLifecycle } from '../../helpers/customerLifecycle.js';
import { queryBudgetMs, pageLimit, decodePage, beforePage, finishPage, invalidPage } from './queryBudget.js';

const models = { conversations: Conversation, messages: Message, calls: CallLog, appointments: Appointment,
  voiceSessions: VoiceSession, interventions: Alert, intelligence: Intelligence, conversionEvents: ConversionEvent };
const oid = value => new mongoose.Types.ObjectId(String(value));
// Legacy histories can be linked only by conversation. Keep that relationship
// authoritative without transferring an unbounded conversation-ID array to Node.
export function historyPipeline({ section, businessId, lead, cursor = null, pageSize = null }) {
  const business = oid(businessId), leadId = oid(lead._id);
  const seek = beforePage(cursor, 'createdAt');
  const conversationMatch = { business, $or: [{ lead: leadId }, ...(lead.phone ? [{ customerPhone: lead.phone }] : [])] };
  if (section === 'conversations') return [{ $match: { $and: [conversationMatch, seek] } }];
  if (section === 'conversionEvents') return [{ $match: { business, lead: leadId, ...seek } }];
  const direct = [{ lead: leadId }];
  if (section === 'calls' && lead.phone) direct.push({ from: lead.phone }, { to: lead.phone });
  const cap = pageSize ? [{ $sort: { createdAt: -1, _id: -1 } }, { $limit: pageSize + 1 }] : [];
  // Direct indexed lead lookup plus only this customer's related conversations.
  // The legacy branch excludes direct matches, so a record is returned once.
  return [
    { $match: { $and: [{ business, $or: direct }, seek] } }, ...cap,
    { $unionWith: { coll: Conversation.collection.name, pipeline: [
      { $match: conversationMatch },
      { $lookup: { from: models[section].collection.name, localField: '_id', foreignField: 'conversation', as: '_history',
        pipeline: [{ $match: { $and: [{ business, $nor: direct }, seek] } }, ...cap] } },
      { $unwind: '$_history' }, { $replaceWith: '$_history' },
    ] } },
  ];
}
const execute = (section, pipeline) => models[section].aggregate(pipeline).option({ maxTimeMS: queryBudgetMs() });
export async function readCustomerHistory({ businessId, lead, section, cursor, limit }) {
  if (!Object.hasOwn(models, section)) throw invalidPage('Unknown customer history section');
  const scope = `customer:${businessId}:${lead._id}:${section}`, size = pageLimit(limit);
  const rows = await execute(section, [...historyPipeline({ section, businessId, lead, cursor: decodePage(cursor, scope), pageSize: size }),
    { $sort: { createdAt: -1, _id: -1 } }, { $limit: size + 1 }]);
  const page = finishPage(rows, size, scope);
  if (section === 'appointments') page.items = await Appointment.populate(page.items, { path: 'serviceOffering', options: { maxTimeMS: queryBudgetMs() } });
  if (section === 'interventions') page.items = await Alert.populate(page.items, { path: 'assignedTo', select: 'userName email', options: { maxTimeMS: queryBudgetMs() } });
  // Compatibility: a returned message page displays chronologically; its cursor
  // is computed before reversal so continuation always walks into older history.
  if (section === 'messages') page.items.reverse();
  return page;
}
export async function readCustomerSummary({ businessId, lead }) {
  const pipeline = section => historyPipeline({ section, businessId, lead });
  const [conversations, appointments, voiceSessions, current, intervention, latestConversation, latestIntelligence] = await Promise.all([
    execute('conversations', [...pipeline('conversations'), { $group: { _id: { status: '$status', booking: '$bookingState.status',
      engaged: { $or: [{ $ne: [{ $ifNull: ['$lastMessageAt', null] }, null] }, { $ne: [{ $ifNull: ['$lastMessage', ''] }, ''] }] } } } }]),
    execute('appointments', [...pipeline('appointments'), { $group: { _id: '$status', count: { $sum: 1 }, revenue: { $sum: { $max: [0, { $ifNull: ['$actualRevenue', 0] }] } },
      estimate: { $sum: verifiedAmountExpression }, estimatedCount: { $sum: { $cond: [{ $ne: [verifiedAmountExpression, null] }, 1, 0] } } } }]),
    execute('voiceSessions', [...pipeline('voiceSessions'), { $group: { _id: { status: '$status', outcome: '$outcome' } } }]),
    execute('appointments', [...pipeline('appointments'), { $match: { status: { $in: ['held', 'confirmed', 'rescheduled'] } } }, { $sort: { startAt: -1, _id: -1 } }, { $limit: 1 }]),
    execute('interventions', [...pipeline('interventions'), { $match: { resolvedAt: null } }, { $sort: { actionRequired: -1, createdAt: -1, _id: -1 } }, { $limit: 1 }]),
    execute('conversations', [...pipeline('conversations'), { $sort: { lastMessageAt: -1, createdAt: -1, _id: -1 } }, { $limit: 1 }]),
    execute('intelligence', [...pipeline('intelligence'), { $sort: { updatedAt: -1, _id: -1 } }, { $limit: 1 }]),
  ]);
  const customerLifecycleStatus = deriveCanonicalLifecycle({ lead,
    conversations: conversations.map(x => ({ status: x._id.status, bookingState: { status: x._id.booking }, lastMessage: x._id.engaged ? 'activity' : '' })),
    appointments: appointments.map(x => ({ status: x._id })), voiceSessions: voiceSessions.map(x => x._id) });
  await Appointment.populate(current, { path: 'serviceOffering', options: { maxTimeMS: queryBudgetMs() } });
  await Alert.populate(intervention, { path: 'assignedTo', select: 'userName email', options: { maxTimeMS: queryBudgetMs() } });
  const completed = appointments.find(x => x._id === 'completed'), confirmed = appointments.find(x => x._id === 'confirmed');
  return { customerLifecycleStatus, appointmentCount: appointments.reduce((n, x) => n + x.count, 0), completed: Boolean(completed),
    actualRevenue: completed?.revenue || 0, confirmedCount: confirmed?.count || 0,
    estimatedRevenue: confirmed?.estimatedCount ? confirmed.estimate : null,
    conversation: latestConversation[0] || null, intelligence: latestIntelligence[0] || null,
    appointment: current[0] || null, intervention: intervention[0] || null };
}
export async function readCustomerDetail(options) {
  const pages = {}, sections = Object.keys(models);
  // Bound simultaneous database operations even for the full detail envelope.
  for (let start = 0; start < sections.length; start += 3) await Promise.all(sections.slice(start, start + 3).map(async section => {
    pages[section] = await readCustomerHistory({ ...options, section });
  }));
  return { pages, summary: await readCustomerSummary(options) };
}
