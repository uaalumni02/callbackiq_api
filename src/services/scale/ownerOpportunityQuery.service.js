import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Lead from '../../models/lead.js';
import Conversation from '../../models/conversation.js';
import Appointment from '../../models/appointment.js';
import Alert from '../../models/alert.js';
import { ACTIVE_LEAD_STATUSES, LEAD_WORKFLOW_INDEXES, opportunityLookup, ownerAppointmentFilter, ownerAppointmentSort, ownerConversationSort } from './leadWorkflowPolicy.js';
export { ownerAppointmentFilter, ownerAppointmentSort, ownerConversationSort } from './leadWorkflowPolicy.js';
import ScaleCache from '../scaleCache.service.js';
import { queryBudgetMs, pageLimit, decodePage, beforePage, finishPage, invalidPage } from './queryBudget.js';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const activeLead = { status: { $in: ACTIVE_LEAD_STATUSES }, archivedAt: null };
const viewFilter = (view, autoBooking) => ({
  active: activeLead,
  booked: { status: 'booked' },
  not_booked: { status: 'lost' },
  ready: { ...activeLead, 'workflowFlags.ready': autoBooking ? { $in: [] } : true },
  waiting: { ...activeLead, 'workflowFlags.waiting': true },
  needs_me: { ...activeLead, 'workflowFlags.needsMe': true },
  all: {},
})[view];
const execute = (pipeline, hint) => Lead.aggregate(pipeline)
  .option({ maxTimeMS: queryBudgetMs(), ...(hint ? { hint } : {}) });
export const ownerStatusPipeline = businessId => [
  { $match: { business: businessId } },
  { $group: { _id: '$status', count: { $sum: 1 }, unarchived: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$archivedAt', null] }, null] }, 1, 0] } } } },
];
export const ownerWorkflowPipeline = (businessId, autoBooking) => [
  { $match: { business: businessId, ...activeLead, $or: [
    { 'workflowFlags.ready': true }, { 'workflowFlags.needsMe': true }, { 'workflowFlags.waiting': true },
  ] } },
  { $group: {
    _id: null,
    readyToSchedule: { $sum: { $cond: [{ $and: [!autoBooking, '$workflowFlags.ready'] }, 1, 0] } },
    needsMe: { $sum: { $cond: ['$workflowFlags.needsMe', 1, 0] } },
    waiting: { $sum: { $cond: ['$workflowFlags.waiting', 1, 0] } },
  } },
];
export const ownerSummaryKey = (businessId, autoBooking, interventionFilter) =>
  `owner-workflow-summary:v4:${crypto.createHash('sha256').update(JSON.stringify([String(businessId), autoBooking, interventionFilter])).digest('hex')}`;
export async function readOwnerSummary({ businessId, autoBooking, interventionFilter }) {
  return ScaleCache.getOrLoad({ key: ownerSummaryKey(businessId, autoBooking, interventionFilter), ttlMs: 10000, staleMs: 30000, loader: async () => {
    const statuses = await execute(ownerStatusPipeline(businessId));
    const count = name => statuses.find(row => row._id === name)?.count || 0;
    const active = statuses.filter(row => ACTIVE_LEAD_STATUSES.includes(row._id)).reduce((sum, row) => sum + row.unarchived, 0);
    const [workflow] = active ? await execute(ownerWorkflowPipeline(businessId, autoBooking)) : [];
    return { stats: { active, readyToSchedule: workflow?.readyToSchedule || 0,
      needsMe: workflow?.needsMe || 0, waiting: workflow?.waiting || 0, booked: count('booked') },
      total: statuses.reduce((sum, row) => sum + row.count, 0), lost: count('lost'), observedAt: new Date().toISOString() };
  } });
}
const ownerOpportunityPagePipeline = (match, continuation, offset, size) => [
  { $match: continuation ? { $and: [match, beforePage(continuation, 'updatedAt')] } : match },
  { $sort: { updatedAt: -1, _id: -1 } },
  ...(offset ? [{ $skip: offset }] : []),
  { $limit: size + 1 },
];

export async function queryOwnerOpportunities({ business, interventionFilter, view = 'active', search = '', limit, skip = 0, cursor, includeSummary = true }) {
  view = ['active', 'booked', 'not_booked', 'ready', 'waiting', 'needs_me', 'all'].includes(view) ? view : 'active';
  const size = pageLimit(limit), offset = Number(skip) || 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 1000 || (cursor && offset)) throw invalidPage('Use the continuation cursor instead of a deep offset');
  search = String(search).trim().slice(0, 120);
  const businessId = new mongoose.Types.ObjectId(String(business._id));
  const scope = `opportunities:${businessId}:${view}:${search}`;
  const continuation = decodePage(cursor, scope);
  const searchMatch = search ? { $or: ['customerName', 'phone', 'serviceNeeded', 'summary'].map(key => ({ [key]: new RegExp(escape(search), 'i') })) } : {};
  const autoBooking = Boolean(business.features?.aiBookingEnabled);
  const match = { business: businessId, ...searchMatch, ...viewFilter(view, autoBooking) };
  const base = [{ $match: match }];
  const rows = await execute([...ownerOpportunityPagePipeline(match, continuation, offset, size),
    opportunityLookup(Conversation, businessId, '_conversation', {}, ownerConversationSort,
      { lead: 1, serviceEligibility: 1, customerName: 1, customerPhone: 1, status: 1, humanTakeover: 1, bookingState: 1, orchestration: 1, conversationMemory: 1, lastMessage: 1, lastMessageAt: 1, createdAt: 1, updatedAt: 1 }),
    opportunityLookup(Appointment, businessId, '_appointment', ownerAppointmentFilter, ownerAppointmentSort,
      { lead: 1, status: 1, startAt: 1, endAt: 1, timezone: 1, source: 1, bookedBy: 1, provider: 1, confirmedAt: 1, customerConfirmedAt: 1, estimatedValue: 1, valuation: 1, actualRevenue: 1, requiresBusinessApproval: 1, failureReason: 1, createdAt: 1 }),
    opportunityLookup(Alert, businessId, '_interventions', interventionFilter),
  ], LEAD_WORKFLOW_INDEXES[view]?.name);
  const page = finishPage(rows, size, scope, 'updatedAt');
  const result = { rows: page.items, pagination: { ...page.pagination, skip: offset } };
  if (includeSummary) {
    const summary = await readOwnerSummary({ businessId, autoBooking, interventionFilter });
    let total;
    if (!search) {
      total = { active: summary.stats.active, booked: summary.stats.booked, not_booked: summary.lost,
        ready: summary.stats.readyToSchedule, waiting: summary.stats.waiting, needs_me: summary.stats.needsMe, all: summary.total }[view];
    } else {
      // Only the search-specific count is keyed by search/view. The shared
      // workflow summary above is reused across all tabs and typed searches.
      const key = crypto.createHash('sha256').update(JSON.stringify([scope, Boolean(business.features?.aiBookingEnabled), interventionFilter])).digest('hex');
      const count = await ScaleCache.getOrLoad({ key: `owner-search-count:v4:${key}`, ttlMs: 10000, staleMs: 30000, loader: async () => {
        const [row] = await execute([...base, { $count: 'value' }], LEAD_WORKFLOW_INDEXES[view]?.name);
        return { value: row?.value || 0 };
      } });
      total = count.value;
    }
    result.stats = summary.stats; result.pagination.total = total; result.summaryObservedAt = summary.observedAt;
  }
  return result;
}
