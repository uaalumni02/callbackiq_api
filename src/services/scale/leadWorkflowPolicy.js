import mongoose from 'mongoose';
import { STALE_INTAKE_HOLD_REASON } from '../booking/intakeReviewContext.service.js';

export const OWNER_INTERVENTION_TYPES = [
  "safety_emergency",
  "human_requested",
  "angry_customer",
  "low_ai_confidence",
  "booking_conflict",
  "integration_failure",
  "message_delivery_failure",
  "unanswered_hot_lead",
  "appointment_canceled",
  "appointment_change_review",
];

export const ownerInterventionFilter = (businessId) => ({
  business: businessId,
  resolvedAt: null,
  $or: [
    { 'metadata.approvalRequest': true, actionRequired: true },
    { type: 'system', actionRequired: true, 'metadata.serviceEligibilityReason': { $exists: true } },
    { type: 'system', actionRequired: true, 'metadata.additionalRequest': { $exists: true } },
    { type: { $in: OWNER_INTERVENTION_TYPES } },
    {
      type: "system",
      priority: "critical",
      $or: [
        { "metadata.messageCategory": "emergency" },
        {
          "metadata.riskFlags": {
            $in: ["safety_hazard", "hazardous_diy_request"],
          },
        },
      ],
    },
    { type: "hot_lead", priority: "critical" },
  ],
});

export const ACTIVE_LEAD_STATUSES = ['new', 'contacted'];
export const LEAD_WORKFLOW_INDEXES = {
  ready: { field: 'ready', name: 'lead_workflow_ready' },
  waiting: { field: 'waiting', name: 'lead_workflow_waiting' },
  needs_me: { field: 'needsMe', name: 'lead_workflow_needs_me' },
};
const active = { $in: ['$status', ACTIVE_LEAD_STATUSES] };
export const ownerConversationSort = { lastMessageAt: -1, updatedAt: -1, _id: -1 };
export const ownerAppointmentSort = { createdAt: -1, _id: -1 };
export const ownerAppointmentFilter = { failureReason: { $ne: STALE_INTAKE_HOLD_REASON } };
const has = field => ({ $gt: [{ $size: `$${field}` }, 0] });
export const opportunityLookup = (model, business, as, match, sort, project) => ({ $lookup: {
  from: model.collection.name, localField: '_id', foreignField: 'lead', as,
  pipeline: [{ $match: { ...match, business } }, ...(sort ? [{ $sort: sort }] : []), { $limit: 1 }, { $project: project || { _id: 1 } }],
} });
const latestConversation = field => ({ $arrayElemAt: [`$_readyConversation.${field}`, 0] });
const firstNonEmpty = (...fields) => fields.reduceRight(
  (fallback, field) => ({ $cond: [{ $in: [{ $ifNull: [field, ''] }, ['', false, 0]] }, fallback, field] }),
  '',
);
const trimmed = input => ({
  $trim: { input: { $convert: { input, to: 'string', onNull: '', onError: '' } } },
});

export function opportunityFlags(business, interventionFilter) {
  const { Alert, Appointment, Conversation } = mongoose.models;
  const eligibility = { $ifNull: [latestConversation('serviceEligibility'), '$serviceEligibility'] };
  const service = trimmed(firstNonEmpty('$serviceNeeded', latestConversation('conversationMemory.serviceNeeded')));
  const address = trimmed(firstNonEmpty(
    latestConversation('bookingState.streetAddress'), latestConversation('conversationMemory.address'), '$address',
  ));
  const preference = firstNonEmpty(latestConversation('bookingState.lastCustomerPreference'), '$preferredAppointmentTime');
  return [
    opportunityLookup(Conversation, business, '_waiting', { status: 'open', 'bookingState.status': { $in: ['offering_slots', 'awaiting_confirmation'] } }),
    opportunityLookup(Conversation, business, '_takeover', { status: 'open', $or: [{ humanTakeover: true }, { 'bookingState.status': { $in: ['failed', 'human_takeover'] } }] }),
    opportunityLookup(Alert, business, '_interventions', interventionFilter),
    opportunityLookup(Appointment, business, '_appointments', ownerAppointmentFilter),
    opportunityLookup(Conversation, business, '_readyConversation', {}, ownerConversationSort, {
      serviceEligibility: 1, humanTakeover: 1, 'bookingState.status': 1, 'bookingState.streetAddress': 1,
      'bookingState.lastCustomerPreference': 1, 'conversationMemory.serviceNeeded': 1, 'conversationMemory.address': 1,
    }),
    { $set: {
      _active: active,
      _needsMe: { $and: [active, { $or: [has('_takeover'), has('_interventions')] }] },
      _isWaiting: { $and: [active, has('_waiting')] },
      _ready: { $and: [
        active, { $not: [has('_interventions')] }, { $not: [has('_appointments')] },
        { $ne: [latestConversation('humanTakeover'), true] },
        { $not: [{ $in: [latestConversation('bookingState.status'), ['failed', 'human_takeover']] }] },
        { $let: { vars: { eligibility }, in: {
          $not: [{ $in: ['$$eligibility.decision', ['needs_staff_review', 'needs_clarification', 'unsupported']] }],
        } } },
        { $not: [{ $in: [service, ['', 'Unknown']] }] },
        { $ne: [address, ''] }, { $ne: [preference, ''] },
      ] },
    } },
  ];
}
