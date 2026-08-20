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
  "high_value_lead",
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

const escapeRegex = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    estimatedValue: Number(appointment.estimatedValue || 0),
    actualRevenue: Number(appointment.actualRevenue || 0),
    failureReason: appointment.failureReason || "",
  };
};

const bookingEvidence = ({ lead, conversation, appointment }) => {
  const state = conversation?.bookingState || {};
  const status = String(state.status || "not_started");
  const stage = BOOKING_STAGE[status] || BOOKING_STAGE.not_started;
  const preference =
    state.lastCustomerPreference || lead?.preferredAppointmentTime || "";
  const offeredSlots = Array.isArray(state.offeredSlots)
    ? state.offeredSlots.map(serializeSlot).filter(Boolean)
    : [];
  const selectedSlot = serializeSlot(state.selectedSlot);

  return {
    stage: status,
    stageLabel: stage.label,
    stageDescription: stage.description,
    customerPreference: preference,
    customerAvailabilityCaptured: Boolean(preference),
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

const nextActionFor = ({ lead, conversation, appointment, evidence, hasOpenIntervention = false }) => {
  if (hasOpenIntervention) {
    return {
      label: "Staff action required",
      detail: "There is an open Needs Attention item for this customer. Review it before the opportunity goes cold.",
      requiresOwner: true,
    };
  }

  if (evidence.humanTakeover || evidence.stage === "human_takeover") {
    return {
      label: "Staff follow-up required",
      detail: "Automation is paused. Review the conversation and contact the customer.",
      requiresOwner: true,
    };
  }

  if (evidence.stage === "failed" || appointment?.status === "failed") {
    return {
      label: "Scheduling needs attention",
      detail: evidence.lastError || appointment?.failureReason || "Review the scheduling failure and contact the customer if needed.",
      requiresOwner: true,
    };
  }

  if (["confirmed", "completed", "no_show"].includes(appointment?.status)) {
    return {
      label: appointment.status === "confirmed" ? "Appointment confirmed" : "Appointment complete",
      detail: "No scheduling action is required.",
      requiresOwner: false,
    };
  }

  if (evidence.stage === "offering_slots") {
    return {
      label: "Waiting for customer",
      detail: "Open times were sent. CallBackIQ is waiting for the customer to choose one.",
      requiresOwner: false,
    };
  }

  if (evidence.stage === "awaiting_confirmation") {
    return {
      label: "Waiting for confirmation",
      detail: "The customer selected a time. CallBackIQ is waiting for their final confirmation.",
      requiresOwner: false,
    };
  }

  if (evidence.stage === "booking") {
    return {
      label: "Booking in progress",
      detail: "CallBackIQ is performing the final availability and booking checks.",
      requiresOwner: false,
    };
  }

  if (["collecting_service", "collecting_location", "collecting_street_address", "collecting_postal_code", "collecting_preference"].includes(evidence.stage)) {
    return {
      label: "CallBackIQ is working",
      detail: stageDetail(evidence.stage),
      requiresOwner: false,
    };
  }

  if (lead?.status === "new") {
    return {
      label: "New customer request",
      detail: "CallBackIQ is beginning recovery and qualification.",
      requiresOwner: false,
    };
  }

  return {
    label: "Recovery in progress",
    detail: "CallBackIQ is continuing the customer conversation.",
    requiresOwner: false,
  };
};

const stageDetail = (stage) =>
  BOOKING_STAGE[stage]?.description || "CallBackIQ is continuing the recovery workflow.";

const serializeOpportunity = ({
  lead,
  conversation,
  appointment,
  hasOpenIntervention = false,
}) => {
  const evidence = bookingEvidence({ lead, conversation, appointment });
  const nextAction = nextActionFor({
    lead,
    conversation,
    appointment,
    evidence,
    hasOpenIntervention,
  });
  const summary =
    lead.summary || conversation?.conversationMemory?.summary || lead.notes || "";

  return {
    id: String(lead._id),
    customerName: lead.customerName || conversation?.customerName || "Customer",
    phone: lead.phone || conversation?.customerPhone || "",
    serviceNeeded: lead.serviceNeeded || conversation?.conversationMemory?.serviceNeeded || "",
    urgency: lead.urgency || conversation?.conversationMemory?.urgency || "medium",
    estimatedValue: Number(lead.estimatedValue || 0),
    actualRevenue: Number(lead.actualRevenue || 0),
    status: lead.status,
    source: lead.source,
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
    booking: evidence,
    appointment: serializeAppointment(appointment),
    needsAttention: hasOpenIntervention,
    nextAction,
  };
};

const latestByLead = (documents) => {
  const map = new Map();
  for (const document of documents) {
    const leadId = document?.lead?._id || document?.lead;
    if (!leadId) continue;
    const key = String(leadId);
    if (!map.has(key)) map.set(key, document);
  }
  return map;
};

const attentionPreview = async (businessId, limit = 5) => {
  const alerts = await Alert.find(ownerInterventionFilter(businessId))
    .populate("lead", "customerName phone serviceNeeded urgency estimatedValue status summary")
    .populate("conversation", "customerName customerPhone lastMessage lastMessageAt status")
    .populate("appointment", "startAt endAt timezone status provider")
    .sort({ dueAt: 1, createdAt: -1 })
    .limit(250)
    .lean();

  const priorityRank = { critical: 4, high: 3, medium: 2, low: 1 };
  alerts.sort((a, b) => {
    const severity = (priorityRank[b.priority] || 0) - (priorityRank[a.priority] || 0);
    if (severity) return severity;
    const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    return aDue - bDue;
  });

  return alerts.slice(0, Math.min(Math.max(Number(limit) || 5, 1), 20)).map((item) => ({
    id: String(item._id),
    type: item.type,
    priority: item.priority,
    title: item.title,
    customerName:
      item.lead?.customerName || item.conversation?.customerName || "Customer",
    phone: item.lead?.phone || item.conversation?.customerPhone || "",
    serviceNeeded: item.lead?.serviceNeeded || "",
    estimatedValue: Number(item.lead?.estimatedValue || 0),
    reason: item.reason || item.message || "",
    recommendedAction: item.recommendedAction || "Review and contact the customer.",
    conversationId: item.conversation?._id ? String(item.conversation._id) : null,
    appointmentId: item.appointment?._id ? String(item.appointment._id) : null,
    dueAt: item.dueAt || null,
  }));
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
      openInterventionCount,
      pipelineRows,
      preview,
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
      Alert.countDocuments(ownerInterventionFilter(business._id)),
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
      attentionPreview(business._id, 5),
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
        needsAttention: openInterventionCount,
        ...pipeline,
      },
      attentionPreview: preview,
    };
  }

  static async opportunities({
    business,
    view = "active",
    search = "",
    limit = 50,
    skip = 0,
  }) {
    const allowedViews = new Set([
      "active",
      "needs_me",
      "waiting",
      "booked",
      "not_booked",
      "all",
    ]);
    const normalizedView = allowedViews.has(view) ? view : "active";
    const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 250);
    const normalizedSkip = Math.max(Number(skip) || 0, 0);
    const normalizedSearch = String(search || "").trim().slice(0, 120);

    const [waitingLeadIds, takeoverLeadIds, interventionLeadIds] = await Promise.all([
      Conversation.distinct("lead", {
        business: business._id,
        status: "open",
        lead: { $ne: null },
        "bookingState.status": { $in: ["offering_slots", "awaiting_confirmation"] },
      }),
      Conversation.distinct("lead", {
        business: business._id,
        status: "open",
        lead: { $ne: null },
        $or: [
          { humanTakeover: true },
          { "bookingState.status": { $in: ["failed", "human_takeover"] } },
        ],
      }),
      Alert.distinct("lead", {
        ...ownerInterventionFilter(business._id),
        lead: { $ne: null },
      }),
    ]);
    const needsMeLeadIds = [
      ...new Map(
        [...takeoverLeadIds, ...interventionLeadIds].map((id) => [
          String(id),
          id,
        ]),
      ).values(),
    ];

    const filter = { business: business._id };
    if (normalizedView === "active") {
      filter.status = { $in: ["new", "contacted"] };
    } else if (normalizedView === "needs_me") {
      filter.status = { $in: ["new", "contacted"] };
      filter._id = { $in: needsMeLeadIds };
    } else if (normalizedView === "waiting") {
      filter.status = { $in: ["new", "contacted"] };
      filter._id = { $in: waitingLeadIds };
    } else if (normalizedView === "booked") {
      filter.status = "booked";
    } else if (normalizedView === "not_booked") {
      filter.status = "lost";
    }

    if (normalizedSearch) {
      const regex = new RegExp(escapeRegex(normalizedSearch), "i");
      filter.$or = [
        { customerName: regex },
        { phone: regex },
        { serviceNeeded: regex },
        { summary: regex },
      ];
    }

    const scopedFilter = { ...filter };
    delete scopedFilter.business;

    const [facet = {}] = await Lead.aggregate([
      { $match: { business: business._id } },
      {
        $facet: {
          page: [
            { $match: scopedFilter },
            { $sort: { updatedAt: -1 } },
            { $skip: normalizedSkip },
            { $limit: cappedLimit },
          ],
          total: [{ $match: scopedFilter }, { $count: "value" }],
          active: [
            { $match: { status: { $in: ["new", "contacted"] } } },
            { $count: "value" },
          ],
          booked: [
            { $match: { status: "booked" } },
            { $count: "value" },
          ],
          waiting: [
            {
              $match: {
                status: { $in: ["new", "contacted"] },
                _id: { $in: waitingLeadIds },
              },
            },
            { $count: "value" },
          ],
          needsMe: [
            {
              $match: {
                status: { $in: ["new", "contacted"] },
                _id: { $in: needsMeLeadIds },
              },
            },
            { $count: "value" },
          ],
        },
      },
    ]);

    const leads = Array.isArray(facet.page) ? facet.page : [];
    const count = (key) => Number(facet?.[key]?.[0]?.value || 0);
    const total = count("total");
    const activeCount = count("active");
    const bookedCount = count("booked");
    const waitingCount = count("waiting");
    const needsMeCount = count("needsMe");

    if (!leads.length) {
      return {
        items: [],
        stats: {
          active: activeCount,
          needsMe: needsMeCount,
          waiting: waitingCount,
          booked: bookedCount,
        },
        pagination: {
          total,
          limit: cappedLimit,
          skip: normalizedSkip,
          hasMore: false,
        },
      };
    }

    const leadIds = leads.map((lead) => lead._id);
    const [conversations, appointments, openInterventionLeadIds] = await Promise.all([
      Conversation.find({ business: business._id, lead: { $in: leadIds } })
        .select(
          "lead customerName customerPhone status humanTakeover bookingState conversationMemory lastMessage lastMessageAt createdAt updatedAt",
        )
        .sort({ lastMessageAt: -1, updatedAt: -1 })
        .lean(),
      Appointment.find({ business: business._id, lead: { $in: leadIds } })
        .select(
          "lead status startAt endAt timezone source bookedBy provider confirmedAt customerConfirmedAt estimatedValue actualRevenue failureReason createdAt",
        )
        .sort({ createdAt: -1 })
        .lean(),
      Alert.distinct("lead", {
        ...ownerInterventionFilter(business._id),
        lead: { $in: leadIds },
      }),
    ]);

    const conversationByLead = latestByLead(conversations);
    const appointmentByLead = latestByLead(appointments);
    const openInterventionLeadSet = new Set(openInterventionLeadIds.map((id) => String(id)));
    const items = leads
      .map((lead) =>
        serializeOpportunity({
          lead,
          conversation: conversationByLead.get(String(lead._id)) || null,
          appointment: appointmentByLead.get(String(lead._id)) || null,
          hasOpenIntervention: openInterventionLeadSet.has(String(lead._id)),
        }),
      )
      .sort((a, b) => {
        if (a.nextAction.requiresOwner !== b.nextAction.requiresOwner) {
          return a.nextAction.requiresOwner ? -1 : 1;
        }
        const urgency = (URGENCY_RANK[b.urgency] || 0) - (URGENCY_RANK[a.urgency] || 0);
        if (urgency) return urgency;
        return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
      });

    return {
      items,
      stats: {
        active: activeCount,
        needsMe: needsMeCount,
        waiting: waitingCount,
        booked: bookedCount,
      },
      pagination: {
        total,
        limit: cappedLimit,
        skip: normalizedSkip,
        hasMore: normalizedSkip + items.length < total,
      },
    };
  }
}

export {
  BOOKING_STAGE,
  OWNER_INTERVENTION_TYPES,
  ownerInterventionFilter,
  resolveOwnerPeriod,
};
export default OwnerExperienceService;
