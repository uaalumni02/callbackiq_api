import { queryBudgetMs } from "./scale/queryBudget.js";
import { queryOwnerOpportunities } from "./scale/ownerOpportunityQuery.service.js";
import { intakeReviewVersion, manualIntakeSubmitted } from "./booking/intakeReviewContext.service.js";
import mongoose from "mongoose";
import Alert from "../models/alert.js";
import Appointment from "../models/appointment.js";
import Conversation from "../models/conversation.js";
import Lead from "../models/lead.js";
import RevenueRecoveryService from "./analytics/revenueRecovery.service.js";
import { resolveOwnerPeriod } from "./ownerExperiencePeriod.service.js";

const OWNER_INTERVENTION_TYPES = [
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

const BOOKING_STAGE = {
  not_started: {
    label: "Not scheduling yet",
    description: "The customer has not started appointment scheduling.",
  },
  collecting_service: {
    label: "Confirming service",
    description: "CallBackIQ is confirming which service the customer needs.",
  },
  collecting_location: {
    label: "Collecting address",
    description: "CallBackIQ is collecting the service address.",
  },
  collecting_street_address: {
    label: "Collecting address",
    description: "CallBackIQ is collecting the service address.",
  },
  collecting_postal_code: {
    label: "Collecting ZIP code",
    description: "CallBackIQ is validating the service area.",
  },
  collecting_preference: {
    label: "Waiting for availability",
    description: "The customer is being asked what day and time work best.",
  },
  offering_slots: {
    label: "Times offered",
    description: "Availability was checked and open appointment times were sent to the customer.",
  },
  awaiting_confirmation: {
    label: "Waiting for confirmation",
    description: "The customer selected a time and CallBackIQ is waiting for final confirmation.",
  },
  booking: {
    label: "Confirming appointment",
    description: "CallBackIQ is performing the final booking step.",
  },
  pending_business_confirmation: {
    label: "Awaiting business confirmation",
    description: "The business must approve this appointment before it is confirmed.",
  },
  booked: {
    label: "Booked",
    description: "The appointment was confirmed.",
  },
  failed: {
    label: "Scheduling needs attention",
    description: "Automated scheduling could not complete and may require staff follow-up.",
  },
  human_takeover: {
    label: "Staff follow-up",
    description: "Automated scheduling is paused for a person to take over.",
  },
};

const URGENCY_RANK = {
  emergency: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const ownerInterventionFilter = (businessId) => ({
  business: businessId,
  resolvedAt: null,
  $or: [
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

const serializeSlot = (slot) => {
  if (!slot?.startAt) return null;
  return {
    startAt: new Date(slot.startAt).toISOString(),
    endAt: slot.endAt ? new Date(slot.endAt).toISOString() : null,
    timezone: slot.timezone || "America/New_York",
    label: slot.label || "",
  };
};

const serializeAppointment = (appointment) => {
  if (!appointment) return null;
  return {
    id: String(appointment._id),
    status: appointment.status,
    startAt: appointment.startAt?.toISOString?.() || appointment.startAt || null,
    endAt: appointment.endAt?.toISOString?.() || appointment.endAt || null,
    timezone: appointment.timezone,
    source: appointment.source,
    bookedBy: appointment.bookedBy,
    provider: appointment.provider,
    confirmedAt:
      appointment.confirmedAt?.toISOString?.() || appointment.confirmedAt || null,
    customerConfirmedAt:
      appointment.customerConfirmedAt?.toISOString?.() ||
      appointment.customerConfirmedAt ||
      null,
    estimatedValue: appointment.estimatedValue ?? null,
    valuation: appointment.valuation,
    actualRevenue: Number(appointment.actualRevenue || 0),
    requiresBusinessApproval: Boolean(appointment.requiresBusinessApproval),
    failureReason: appointment.failureReason || "",
  };
};

const bookingEvidence = ({ lead, conversation, appointment }) => {
  const state = conversation?.bookingState || {};
  const status = String(state.status || "not_started");
  const awaitingReview = manualIntakeSubmitted(conversation) && !appointment &&
    !["offering_slots", "awaiting_confirmation", "booking", "pending_business_confirmation", "booked"].includes(status);
  const stage = awaitingReview
    ? { label: "Awaiting business review", description: "The captured service request needs staff review. Check service coverage and availability before confirming an appointment." }
    : BOOKING_STAGE[status] || BOOKING_STAGE.not_started;
  const preference =
    state.lastCustomerPreference || lead?.preferredAppointmentTime || "";
  const offeredSlots = Array.isArray(state.offeredSlots)
    ? state.offeredSlots.map(serializeSlot).filter(Boolean)
    : [];
  const selectedSlot = serializeSlot(state.selectedSlot);
  const serviceNeeded = String(
    lead?.serviceNeeded || conversation?.conversationMemory?.serviceNeeded || "",
  ).trim();
  const rawAddress = String(
    state.streetAddress ||
      conversation?.conversationMemory?.address ||
      lead?.address ||
      "",
  ).trim();
  const postalCode = String(
    state.postalCode || rawAddress.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || "",
  ).trim();
  const urgency = [lead?.urgency, conversation?.conversationMemory?.urgency]
    .filter(value => value in URGENCY_RANK)
    .sort((a, b) => URGENCY_RANK[b] - URGENCY_RANK[a])[0] || "";
  const serviceCaptured = Boolean(serviceNeeded && serviceNeeded !== "Unknown");
  const addressCaptured = Boolean(rawAddress);
  const urgencyCaptured = Boolean(
    conversation?.conversationMemory?.urgency || lead?.qualifiedAt,
  );

  return {
    stage: status,
    stageLabel: stage.label,
    stageDescription: stage.description,
    customerPreference: preference,
    customerAvailabilityCaptured: Boolean(preference),
    serviceOfferingId: state.serviceOffering ? String(state.serviceOffering) : null,
    serviceCaptured,
    addressCaptured,
    urgencyCaptured,
    detailsCaptured: serviceCaptured && addressCaptured,
    streetAddress: rawAddress,
    postalCode,
    urgency,
    availabilityCheckedAt:
      state.lastAvailabilityCheckedAt?.toISOString?.() ||
      state.lastAvailabilityCheckedAt ||
      null,
    availabilityChecked: Boolean(state.lastAvailabilityCheckedAt),
    offeredSlots,
    selectedSlot,
    selectedSlotCaptured: Boolean(selectedSlot),
    appointmentId:
      state.appointment || appointment?._id
        ? String(state.appointment || appointment._id)
        : null,
    lastError: state.lastError || "",
    humanTakeover: Boolean(conversation?.humanTakeover),
    appointmentConfirmed: ["confirmed", "completed", "no_show"].includes(
      appointment?.status,
    ),
  };
};

// CALLBACKIQ_AUTHORITATIVE_OWNER_JOURNEY_V1
const nextActionFor = ({
  business,
  lead,
  conversation,
  appointment,
  evidence,
  hasOpenIntervention = false,
}) => {
  const autoBookingEnabled = Boolean(business?.features?.aiBookingEnabled);
  const appointmentStatus = String(appointment?.status || "");

  // Needs Attention is exception-only. A customer ready for ordinary staff
  // scheduling belongs in the normal Appointments workflow.
  if (hasOpenIntervention) {
    return {
      kind: "exception",
      label: "Staff action required",
      detail:
        "CallBackIQ hit an exception that automation cannot safely finish. Review the required action.",
      requiresOwner: true,
      actionRequired: true,
    };
  }

  const eligibility = conversation?.serviceEligibility || lead?.serviceEligibility;
  if (eligibility?.decision === 'unsupported') return {
    kind: 'closed', label: 'Service not offered', detail: 'The requested work is outside the approved offerings. No appointment should be arranged for this request.',
    requiresOwner: false, actionRequired: false,
  };
  if (eligibility?.decision === 'needs_staff_review') return {
    kind: 'exception', label: 'Review service eligibility', detail: `${eligibility.request || 'Requested service'} — ${String(eligibility.reason || 'scope uncertain').replace(/_/g, ' ')}. ${eligibility.reviewSubmitted ? 'Customer requested review.' : 'Awaiting customer permission to submit review.'}`,
    requiresOwner: eligibility.reviewSubmitted === true, actionRequired: eligibility.reviewSubmitted === true,
  };
  if (eligibility?.decision === 'needs_clarification') return {
    kind: 'qualify', label: 'Clarify requested service', detail: 'The requested work has not yet been matched to an approved offering.', requiresOwner: false, actionRequired: false,
  };

  if (evidence.humanTakeover || evidence.stage === "human_takeover") {
    return {
      kind: "exception",
      label: "Staff follow-up required",
      detail:
        "Automation is paused for this customer. Review the conversation and take over.",
      requiresOwner: true,
      actionRequired: true,
    };
  }

  if (evidence.stage === "failed" || appointmentStatus === "failed") {
    return {
      kind: "exception",
      label: "Scheduling needs attention",
      detail:
        evidence.lastError ||
        appointment?.failureReason ||
        "Review the scheduling failure and contact the customer if needed.",
      requiresOwner: true,
      actionRequired: true,
    };
  }

  if (
    appointmentStatus === "held" &&
    appointment?.requiresBusinessApproval === true
  ) {
    return {
      kind: "approval",
      label: "Appointment approval ready",
      detail:
        "CallBackIQ held a real slot. Review the request and accept or decline it from Appointments.",
      requiresOwner: false,
      actionRequired: true,
    };
  }

  if (appointmentStatus === "confirmed") {
    return {
      kind: "appointment",
      label: "Appointment confirmed",
      detail:
        "The customer and calendar are confirmed. Manage the visit from Appointments.",
      requiresOwner: false,
      actionRequired: false,
    };
  }

  if (["completed", "no_show"].includes(appointmentStatus)) {
    return {
      kind: "complete",
      label:
        appointmentStatus === "completed" ? "Job completed" : "No-show recorded",
      detail:
        appointmentStatus === "completed"
          ? "The service outcome is recorded and available in revenue and attribution reporting."
          : "The no-show outcome is recorded on the appointment.",
      requiresOwner: false,
      actionRequired: false,
    };
  }

  const readyForStaffScheduling =
    !autoBookingEnabled &&
    !appointment &&
    evidence.customerAvailabilityCaptured &&
    evidence.serviceCaptured &&
    evidence.addressCaptured;

  if (readyForStaffScheduling) {
    return {
      kind: "schedule",
      label: "Ready to schedule",
      detail:
        "CallBackIQ collected the service, address, urgency context, and customer preference. Check real availability and choose a time.",
      requiresOwner: false,
      actionRequired: true,
    };
  }

  if (evidence.stage === "offering_slots") {
    return {
      kind: "customer",
      label: "Waiting for customer",
      detail:
        "Open times were sent. CallBackIQ is waiting for the customer to choose one.",
      requiresOwner: false,
      actionRequired: false,
    };
  }

  if (evidence.stage === "awaiting_confirmation") {
    return {
      kind: "customer",
      label: "Waiting for confirmation",
      detail:
        "The customer selected a time. CallBackIQ is waiting for their final confirmation.",
      requiresOwner: false,
      actionRequired: false,
    };
  }

  if (evidence.stage === "booking") {
    return {
      kind: "automation",
      label: "Booking in progress",
      detail:
        "CallBackIQ is performing the final availability and booking checks.",
      requiresOwner: false,
      actionRequired: false,
    };
  }

  if (
    [
      "collecting_service",
      "collecting_location",
      "collecting_street_address",
      "collecting_postal_code",
      "collecting_preference",
    ].includes(evidence.stage)
  ) {
    return {
      kind: "automation",
      label: "CallBackIQ is working",
      detail: stageDetail(evidence.stage),
      requiresOwner: false,
      actionRequired: false,
    };
  }

  if (lead?.status === "new") {
    return {
      kind: "automation",
      label: "New customer request",
      detail: "CallBackIQ is beginning recovery and qualification.",
      requiresOwner: false,
      actionRequired: false,
    };
  }

  return {
    kind: "automation",
    label: "Recovery in progress",
    detail: "CallBackIQ is continuing the customer conversation.",
    requiresOwner: false,
    actionRequired: false,
  };
};

const stageDetail = (stage) =>
  BOOKING_STAGE[stage]?.description || "CallBackIQ is continuing the recovery workflow.";

const serializeOpportunity = ({
  business,
  lead,
  conversation,
  appointment,
  hasOpenIntervention = false,
}) => {
  const evidence = bookingEvidence({ lead, conversation, appointment });
  const nextAction = nextActionFor({
    business,
    lead,
    conversation,
    appointment,
    evidence,
    hasOpenIntervention,
  });
  const summary =
    lead.summary || conversation?.conversationMemory?.summary || lead.notes || "";

  return {
    serviceEligibility: conversation?.serviceEligibility || lead.serviceEligibility || null,
    id: String(lead._id),
    customerName: lead.customerName || conversation?.customerName || "Customer",
    phone: lead.phone || conversation?.customerPhone || "",
    email: lead.email || "",
    address:
      lead.address || conversation?.conversationMemory?.address || evidence.streetAddress || "",
    serviceNeeded: lead.serviceNeeded || conversation?.conversationMemory?.serviceNeeded || "",
    urgency: lead.urgency || conversation?.conversationMemory?.urgency || "medium",
    estimatedValue: lead.estimatedValue ?? null,
    valuation: lead.valuation,
    actualRevenue: Number(lead.actualRevenue || 0),
    status: lead.status,
    source: lead.source,
    attribution: {
      sourceName:
        lead.latestAttribution?.sourceName ||
        lead.firstAttribution?.sourceName ||
        "",
      channel:
        lead.latestAttribution?.channel ||
        lead.firstAttribution?.channel ||
        "",
      campaign:
        lead.latestAttribution?.campaign ||
        lead.firstAttribution?.campaign ||
        "",
      trackingNumber:
        lead.latestAttribution?.trackingNumber ||
        lead.firstAttribution?.trackingNumber ||
        "",
      acquisitionSourceName: lead.firstAttribution?.sourceName || "",
    },
    summary,
    recovered: Boolean(lead.recovered),
    recoveredBy: lead.recoveredBy || null,
    qualifiedAt: lead.qualifiedAt?.toISOString?.() || lead.qualifiedAt || null,
    firstRespondedAt:
      lead.firstRespondedAt?.toISOString?.() || lead.firstRespondedAt || null,
    updatedAt: lead.updatedAt?.toISOString?.() || lead.updatedAt || null,
    conversation: conversation
      ? {
          id: String(conversation._id),
          status: conversation.status,
          lastMessage: conversation.lastMessage || "",
          lastMessageAt:
            conversation.lastMessageAt?.toISOString?.() ||
            conversation.lastMessageAt ||
            null,
          humanTakeover: Boolean(conversation.humanTakeover),
        }
      : null,
    booking: { ...evidence,
      manualIntakeSubmitted: manualIntakeSubmitted(conversation),
      intakeReviewAppointmentId: conversation?.conversationMemory?.recoveryIntake?.reviewAppointmentId || null,
      intakeApprovedAppointmentId: conversation?.conversationMemory?.recoveryIntake?.appointmentId || null,
      intakeReviewVersion: conversation ? intakeReviewVersion(conversation, lead) : null,
    },
    appointment: serializeAppointment(appointment),
    needsAttention: hasOpenIntervention,
    nextAction,
  };
};


// Group before limiting: repeated issues must not crowd other customers out.
// Conversation is the actionable unit; unlinked issues retain their identity.
export const ownerAttentionPipeline = (businessId, limit = 5) => [
  { $match: ownerInterventionFilter(new mongoose.Types.ObjectId(String(businessId))) },
  { $addFields: {
    attentionKey: { $cond: [ { $ne: [{ $ifNull: ["$conversation", null] }, null] },
      { conversation: "$conversation" },
      { $cond: [ { $ne: [{ $ifNull: ["$lead", null] }, null] },
        { lead: "$lead" }, { alert: "$_id" } ] } ] },
    attentionPriority: { $switch: { branches: [
      { case: { $eq: ["$priority", "critical"] }, then: 4 },
      { case: { $eq: ["$priority", "high"] }, then: 3 },
      { case: { $eq: ["$priority", "medium"] }, then: 2 },
      { case: { $eq: ["$priority", "low"] }, then: 1 },
    ], default: 0 } },
    attentionDue: { $ifNull: ["$dueAt", new Date("9999-12-31T00:00:00.000Z")] },
  } },
  { $sort: { attentionPriority: -1, attentionDue: 1, createdAt: -1, _id: 1 } },
  { $group: { _id: "$attentionKey", representative: { $first: "$$ROOT" }, issueCount: { $sum: 1 } } },
  { $sort: { "representative.attentionPriority": -1, "representative.attentionDue": 1,
    "representative.createdAt": -1, "representative._id": 1 } },
  { $facet: {
    totals: [{ $group: { _id: null, count: { $sum: 1 }, issueCount: { $sum: "$issueCount" } } }],
    preview: [{ $limit: Math.min(Math.max(Number(limit) || 5, 1), 20) },
      { $project: { _id: 0, representative: 1, issueCount: 1 } }],
  } },
];

export const attentionSummary = async (businessId, limit = 5) => {
  const [result] = await Alert.aggregate(ownerAttentionPipeline(businessId, limit))
    .option({ maxTimeMS: queryBudgetMs() });
  const groups = result?.preview || [];
  const alerts = await Alert.populate(groups.map(group => group.representative), [
    { path: "lead", select: "customerName phone serviceNeeded urgency estimatedValue valuation status summary serviceEligibility" },
    { path: "conversation", select: "customerName customerPhone lastMessage lastMessageAt status" },
    { path: "appointment", select: "startAt endAt timezone status provider" },
  ]);
  return {
    count: result?.totals?.[0]?.count || 0,
    issueCount: result?.totals?.[0]?.issueCount || 0,
    preview: alerts.map((item, index) => ({
      id: String(item._id), issueCount: groups[index].issueCount,
      type: item.type, priority: item.priority, title: item.title,
      customerName: item.lead?.customerName || item.conversation?.customerName || "Customer",
      phone: item.lead?.phone || item.conversation?.customerPhone || "",
      serviceNeeded: item.lead?.serviceNeeded || "",
      estimatedValue: item.lead?.estimatedValue ?? null, valuation: item.lead?.valuation,
      reason: item.reason || item.message || "",
      recommendedAction: item.recommendedAction || "Review and contact the customer.",
      conversationId: item.conversation?._id ? String(item.conversation._id) : null,
      appointmentId: item.appointment?._id ? String(item.appointment._id) : null,
      dueAt: item.dueAt || null,
    })),
  };
};

class OwnerExperienceService {
  static resolvePeriod(options) {
    return resolvePeriod(options);
  }

  static async dashboard({ business, period = "today", now = new Date() }) {
    const timeZone = business.timezone || "America/New_York";
    const range = resolveOwnerPeriod({ period, timeZone, now });
    const endInclusive = range.end;

    const [
      revenue,
      openCustomerCount,
      pipelineRows,
      attention,
    ] = await Promise.all([
      RevenueRecoveryService.summary({
        businessId: business._id,
        startDate: range.start,
        endDate: endInclusive,
      }),
      Lead.countDocuments({
        business: business._id,
        status: { $in: ["new", "contacted"] },
      }),
      Conversation.aggregate([
        {
          $match: {
            business: business._id,
            status: "open",
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            staffFollowUp: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $eq: ["$humanTakeover", true] },
                      {
                        $in: [
                          "$bookingState.status",
                          ["human_takeover", "failed"],
                        ],
                      },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            waitingOnCustomer: {
              $sum: {
                $cond: [
                  {
                    $in: [
                      "$bookingState.status",
                      ["offering_slots", "awaiting_confirmation"],
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            bookingNow: {
              $sum: {
                $cond: [{ $eq: ["$bookingState.status", "booking"] }, 1, 0],
              },
            },
          },
        },
        {
          $project: {
            _id: 0,
            staffFollowUp: 1,
            waitingOnCustomer: 1,
            bookingNow: 1,
            automationWorking: {
              $max: [
                0,
                {
                  $subtract: [
                    "$total",
                    {
                      $add: [
                        "$staffFollowUp",
                        "$waitingOnCustomer",
                        "$bookingNow",
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      ]),
      attentionSummary(business._id, 5),
    ]);

    const pipeline = pipelineRows[0] || {
      automationWorking: 0,
      waitingOnCustomer: 0,
      bookingNow: 0,
      staffFollowUp: 0,
    };

    return {
      period: {
        key: range.key,
        label: range.label,
        startDate: range.startDate,
        endDate: range.endDate,
        timeZone,
      },
      business: {
        id: String(business._id),
        businessName: business.businessName,
        timezone: timeZone,
        estimatedJobValue: Number(business.estimatedJobValue || 0),
      },
      outcomes: {
        estimateCoverage: revenue.estimateCoverage,
        bookedEstimateCoverage: revenue.bookedEstimateCoverage,
        missedCalls: revenue.missedCalls,
        customersReached: revenue.customersReached,
        qualifiedLeads: revenue.qualifiedLeads,
        appointmentsBooked: revenue.appointmentsBooked,
        recoveredJobs: revenue.recoveredLeads,
        estimatedRecoveredRevenue: revenue.estimatedRecoveredRevenue,
        actualRecoveredRevenue: revenue.actualRecoveredRevenue,
        estimatedBookedRevenue: revenue.estimatedBookedRevenue,
        actualBookedRevenue: revenue.actualBookedRevenue,
        averageFirstResponseSeconds: revenue.averageFirstResponseSeconds,
      },
      rates: {
        responseRate: revenue.responseRate,
        qualificationRate: revenue.qualificationRate,
        bookingRate: revenue.bookingRate,
        humanInterventionRate: revenue.humanInterventionRate,
      },
      rightNow: {
        openCustomers: openCustomerCount,
        needsAttention: attention.count,
        openReviewItems: attention.issueCount,
        ...pipeline,
      },
      attentionPreview: attention.preview,
    };
  }

  static async opportunity({ business, leadId }) {
    if (!mongoose.isValidObjectId(leadId)) return null;

    const lead = await Lead.findOne({
      _id: leadId,
      business: business._id,
    }).lean();
    if (!lead) return null;

    const [conversation, appointment, openIntervention] = await Promise.all([
      Conversation.findOne({
        business: business._id,
        lead: lead._id,
      })
        .select(
          "lead serviceEligibility customerName customerPhone status humanTakeover bookingState conversationMemory lastMessage lastMessageAt createdAt updatedAt",
        )
        .sort({ lastMessageAt: -1, updatedAt: -1 })
        .lean(),
      Appointment.findOne({
        business: business._id,
        lead: lead._id,
      })
        .select(
          "lead status startAt endAt timezone source bookedBy provider confirmedAt customerConfirmedAt estimatedValue valuation actualRevenue requiresBusinessApproval failureReason createdAt",
        )
        .sort({ createdAt: -1 })
        .lean(),
      Alert.exists({
        ...ownerInterventionFilter(business._id),
        lead: lead._id,
      }),
    ]);

    return serializeOpportunity({
      business,
      lead,
      conversation,
      appointment,
      hasOpenIntervention: Boolean(openIntervention),
    });
  }

  static async opportunities(options) {
    const { business } = options;
    const page = await queryOwnerOpportunities({ ...options, interventionFilter: ownerInterventionFilter(business._id) });
    return { ...page, rows: undefined, items: page.rows.map(row => {
      const { _conversation, _appointment, _interventions, _waiting, _takeover, _appointments, _active, _needsMe, _isWaiting, _ready, ...lead } = row;
      return serializeOpportunity({ business, lead, conversation: _conversation[0] || null,
        appointment: _appointment[0] || null, hasOpenIntervention: _interventions.length > 0 });
    }).sort((a, b) => {
      const rank = { exception: 6, schedule: 5, approval: 5, customer: 4, automation: 3, appointment: 2, complete: 1 };
      return (rank[b.nextAction?.kind] || 0) - (rank[a.nextAction?.kind] || 0)
        || (URGENCY_RANK[b.urgency] || 0) - (URGENCY_RANK[a.urgency] || 0)
        || new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    }) };
  }

}

export {
  BOOKING_STAGE,
  OWNER_INTERVENTION_TYPES,
  ownerInterventionFilter,
  nextActionFor,
  bookingEvidence,
  serializeOpportunity,
  resolveOwnerPeriod,
};
export default OwnerExperienceService;
