import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Appointment from '../../models/appointment.js';
import { queryBudgetMs, decodePage, encodePage } from '../scale/queryBudget.js';
import { presentAppointments } from './appointmentPresentation.service.js';

export const pendingApprovalFilter = () => ({ $or: [
  { requiresBusinessApproval: true, approvalDecisionAt: null,
    $or: [{ status: 'held' }, { status: 'failed', failureReason: /hold expired/i }] },
  { status: 'confirmed', 'rescheduleRequest.status': 'pending' },
] });
const bad = message => Object.assign(new Error(message), { statusCode: 400 });
const statuses = new Set(['held', 'confirmed', 'canceled', 'completed', 'no_show', 'rescheduled', 'failed']);
export function appointmentPageQuery({ businessId, query = {}, now = new Date() }) {
  const view = query.view || 'upcoming';
  if (!['upcoming', 'approvals', 'all'].includes(view)) throw bad('Invalid appointment view.');
  if (query.status && !statuses.has(query.status)) throw bad('Invalid appointment status.');
  const limit = Number(query.pageSize || 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw bad('Page size must be from 1 to 100.');
  const filter = { business: businessId };
  if (query.status) filter.status = query.status;
  for (const [parameter, field] of [['leadId','lead'],['conversationId','conversation']]) if (query[parameter]) {
    if (!mongoose.isObjectIdOrHexString(query[parameter])) throw bad(`Invalid ${parameter}.`);
    filter[field] = query[parameter];
  }
  if (view === 'approvals') filter.$and = [pendingApprovalFilter()];
  if (view === 'upcoming') filter.$and = [{ $or: [pendingApprovalFilter(),
    { status: { $in: ['held','confirmed'] }, endAt: { $gte: now } }],
  }];
  const direction = view === 'all' ? -1 : 1;
  const scope = crypto.createHash('sha256').update(JSON.stringify([String(businessId),view,query.status || '',query.leadId || '',query.conversationId || ''])).digest('hex');
  const cursor = decodePage(query.cursor, scope);
  if (cursor) {
    const comparison = direction === 1 ? '$gt' : '$lt';
    filter.$and = [...(filter.$and || []), { $or: [{ startAt: { [comparison]: cursor.at } },
      { startAt: cursor.at, _id: { [comparison]: cursor.id } }] }];
  }
  return { filter, limit, scope, direction };
}

export async function listAppointmentPage({ businessId, query = {} }) {
  const { filter, limit, scope, direction } = appointmentPageQuery({ businessId, query });
  const [rows, pendingApprovals] = await Promise.all([
    Appointment.find(filter).sort({ startAt: direction, _id: direction }).limit(limit + 1)
      .populate('serviceOffering', 'name category durationMinutes estimatedValue')
      .populate('lead', 'customerName phone email address serviceNeeded urgency status source recovered recoveredBy summary preferredAppointmentTime estimatedValue valuation actualRevenue firstAttribution latestAttribution')
      .populate('conversation', 'customerPhone customerName status humanTakeover bookingState conversationMemory lastMessage lastMessageAt')
      .populate('rescheduledFrom', 'startAt endAt status').populate('rescheduledTo', 'startAt endAt status')
      .maxTimeMS(queryBudgetMs()).lean(),
    Appointment.countDocuments({ business: businessId, ...pendingApprovalFilter() }).maxTimeMS(queryBudgetMs()),
  ]);
  const items = rows.slice(0, limit), last = items.at(-1), hasMore = rows.length > limit;
  return { data: await presentAppointments(items, businessId), summary: { pendingApprovals },
    pagination: { limit, hasMore, nextCursor: hasMore ? encodePage({ scope, at: new Date(last.startAt).toISOString(), id: String(last._id) }) : null } };
}
