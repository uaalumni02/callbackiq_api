import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Lead from '../../models/lead.js';
import Conversation from '../../models/conversation.js';
import Appointment from '../../models/appointment.js';
import Alert from '../../models/alert.js';
import ScaleCache from '../scaleCache.service.js';
import { queryBudgetMs, pageLimit, decodePage, beforePage, finishPage, invalidPage } from './queryBudget.js';
const active = { $in: ['$status', ['new', 'contacted']] };
const has = field => ({ $gt: [{ $size: `$${field}` }, 0] });
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const opportunityLookup = (model, business, as, match, sort, project) => ({ $lookup: {
  from: model.collection.name, localField: '_id', foreignField: 'lead', as,
  pipeline: [{ $match: { ...match, business } }, ...(sort ? [{ $sort: sort }] : []), { $limit: 1 }, { $project: project || { _id: 1 } }],
} });
export function opportunityFlags(business, interventionFilter, autoBooking) {
  return [
    opportunityLookup(Conversation, business, '_waiting', { status: 'open', 'bookingState.status': { $in: ['offering_slots', 'awaiting_confirmation'] } }),
    opportunityLookup(Conversation, business, '_takeover', { status: 'open', $or: [{ humanTakeover: true }, { 'bookingState.status': { $in: ['failed', 'human_takeover'] } }] }),
    opportunityLookup(Alert, business, '_interventions', interventionFilter),
    opportunityLookup(Appointment, business, '_appointments', { status: { $in: ['held', 'confirmed'] } }),
    { $set: { _active: active, _needsMe: { $and: [active, { $or: [has('_takeover'), has('_interventions')] }] }, _isWaiting: { $and: [active, has('_waiting')] },
      _ready: { $and: [!autoBooking, active, { $not: [has('_takeover')] }, { $not: [has('_interventions')] }, { $not: [has('_appointments')] },
        { $not: [{ $in: ['$serviceNeeded', ['', 'Unknown']] }] }, { $not: [{ $in: [{ $ifNull: ['$address', null] }, ['', null]] }] },
        { $not: [{ $in: [{ $ifNull: ['$preferredAppointmentTime', null] }, ['', null]] }] }] } } },
  ];
}
const viewFilter = view => ({ active: { status: { $in: ['new', 'contacted'] } }, booked: { status: 'booked' }, not_booked: { status: 'lost' },
  ready: { _ready: true }, waiting: { _isWaiting: true }, needs_me: { _needsMe: true }, all: {} })[view];
const needsFlags = view => ['ready', 'waiting', 'needs_me'].includes(view);
const execute = pipeline => Lead.aggregate(pipeline).option({ maxTimeMS: queryBudgetMs() });
// All views share this tenant summary; search terms must not multiply the
// expensive workflow joins. Historical closed leads need no workflow joins.
export const ownerStatusPipeline = businessId => [{ $match: { business: businessId } },
  { $group: { _id: '$status', count: { $sum: 1 } } }];
export const ownerWorkflowPipeline = (businessId, flags) => [
  { $match: { business: businessId, status: { $in: ['new', 'contacted'] } } }, ...flags,
  { $group: { _id: null, readyToSchedule: { $sum: { $cond: ['$_ready', 1, 0] } },
    needsMe: { $sum: { $cond: ['$_needsMe', 1, 0] } }, waiting: { $sum: { $cond: ['$_isWaiting', 1, 0] } } } },
];
export const ownerSummaryKey = (businessId, autoBooking, interventionFilter) =>
  `owner-workflow-summary:v2:${crypto.createHash('sha256').update(JSON.stringify([String(businessId), autoBooking, interventionFilter])).digest('hex')}`;
export async function readOwnerSummary({ businessId, flags, autoBooking, interventionFilter }) {
  return ScaleCache.getOrLoad({ key: ownerSummaryKey(businessId, autoBooking, interventionFilter), ttlMs: 10000, staleMs: 30000, loader: async () => {
    const statuses = await execute(ownerStatusPipeline(businessId));
    const count = name => statuses.find(row => row._id === name)?.count || 0;
    const active = count('new') + count('contacted');
    const [workflow] = active ? await execute(ownerWorkflowPipeline(businessId, flags)) : [];
    return { stats: { active, readyToSchedule: workflow?.readyToSchedule || 0,
      needsMe: workflow?.needsMe || 0, waiting: workflow?.waiting || 0, booked: count('booked') },
      total: statuses.reduce((sum, row) => sum + row.count, 0), lost: count('lost'), observedAt: new Date().toISOString() };
  } });
}
export async function queryOwnerOpportunities({ business, interventionFilter, view = 'active', search = '', limit, skip = 0, cursor, includeSummary = true }) {
  view = ['active', 'booked', 'not_booked', 'ready', 'waiting', 'needs_me', 'all'].includes(view) ? view : 'active';
  const size = pageLimit(limit), offset = Number(skip) || 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 1000 || (cursor && offset)) throw invalidPage('Use the continuation cursor instead of a deep offset');
  search = String(search).trim().slice(0, 120);
  const businessId = new mongoose.Types.ObjectId(String(business._id));
  const scope = `opportunities:${businessId}:${view}:${search}`;
  const continuation = decodePage(cursor, scope);
  const searchMatch = search ? { $or: ['customerName', 'phone', 'serviceNeeded', 'summary'].map(key => ({ [key]: new RegExp(escape(search), 'i') })) } : {};
  const flags = opportunityFlags(businessId, interventionFilter, Boolean(business.features?.aiBookingEnabled));
  const base = [{ $match: { business: businessId, ...searchMatch, ...(needsFlags(view) ? { status: { $in: ['new', 'contacted'] } } : {}) } }];
  // Sort and seek on an indexed lead field before joining any foreign records.
  const filtered = [...base, { $match: beforePage(continuation, 'updatedAt') }, { $sort: { updatedAt: -1, _id: -1 } },
    ...(needsFlags(view) ? flags : []), { $match: viewFilter(view) }];
  const rows = await execute([...filtered, ...(offset ? [{ $skip: offset }] : []), { $limit: size + 1 },
    opportunityLookup(Conversation, businessId, '_conversation', {}, { lastMessageAt: -1, updatedAt: -1, _id: -1 },
      { lead: 1, serviceEligibility: 1, customerName: 1, customerPhone: 1, status: 1, humanTakeover: 1, bookingState: 1, orchestration: 1, conversationMemory: 1, lastMessage: 1, lastMessageAt: 1, createdAt: 1, updatedAt: 1 }),
    opportunityLookup(Appointment, businessId, '_appointment', {}, { createdAt: -1, _id: -1 },
      { lead: 1, status: 1, startAt: 1, endAt: 1, timezone: 1, source: 1, bookedBy: 1, provider: 1, confirmedAt: 1, customerConfirmedAt: 1, estimatedValue: 1, valuation: 1, actualRevenue: 1, requiresBusinessApproval: 1, failureReason: 1, createdAt: 1 }),
    ...(!needsFlags(view) ? [opportunityLookup(Alert, businessId, '_interventions', interventionFilter)] : []),
  ]);
  const page = finishPage(rows, size, scope, 'updatedAt');
  const result = { rows: page.items, pagination: { ...page.pagination, skip: offset } };
  if (includeSummary) {
    const summary = await readOwnerSummary({ businessId, flags,
      autoBooking: Boolean(business.features?.aiBookingEnabled), interventionFilter });
    let total;
    if (!search) {
      total = { active: summary.stats.active, booked: summary.stats.booked, not_booked: summary.lost,
        ready: summary.stats.readyToSchedule, waiting: summary.stats.waiting, needs_me: summary.stats.needsMe, all: summary.total }[view];
    } else {
      // Only the search-specific count is keyed by search/view. The shared
      // workflow summary above is reused across all tabs and typed searches.
      const key = crypto.createHash('sha256').update(JSON.stringify([scope, Boolean(business.features?.aiBookingEnabled), interventionFilter])).digest('hex');
      const count = await ScaleCache.getOrLoad({ key: `owner-search-count:v2:${key}`, ttlMs: 10000, staleMs: 30000, loader: async () => {
        const [row] = await execute([...base, ...(needsFlags(view) ? flags : []), { $match: viewFilter(view) }, { $count: 'value' }]);
        return { value: row?.value || 0 };
      } });
      total = count.value;
    }
    result.stats = summary.stats; result.pagination.total = total; result.summaryObservedAt = summary.observedAt;
  }
  return result;
}
