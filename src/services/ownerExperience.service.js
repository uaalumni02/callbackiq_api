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
    requiresBusinessApproval: Boolean(appointment.requiresBusinessApproval),
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
  const urgency = String(
    conversation?.conversationMemory?.urgency || lead?.urgency || "",
  ).trim();
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
    id: String(lead._id),
    customerName: lead.customerName || conversation?.customerName || "Customer",
    phone: lead.phone || conversation?.customerPhone || "",
    email: lead.email || "",
    address:
      lead.address || conversation?.conversationMemory?.address || evidence.streetAddress || "",
    serviceNeeded: lead.serviceNeeded || conversation?.conversationMemory?.serviceNeeded || "",
    urgency: lead.urgency || conversation?.conversationMemory?.urgency || "medium",
    estimatedValue: Number(lead.estimatedValue || 0),
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
          "lead customerName customerPhone status humanTakeover bookingState conversationMemory lastMessage lastMessageAt createdAt updatedAt",
        )
        .sort({ lastMessageAt: -1, updatedAt: -1 })
        .lean(),
      Appointment.findOne({
        business: business._id,
        lead: lead._id,
      })
        .select(
          "lead status startAt endAt timezone source bookedBy provider confirmedAt customerConfirmedAt estimatedValue actualRevenue requiresBusinessApproval failureReason createdAt",
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

  static async opportunities({
    business,
    view = "active",
    search = "",
    limit = 50,
    skip = 0,
  }) {
    const allowedViews = new Set([
      "active",
      "ready",
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

    const autoBookingEnabled = Boolean(business?.features?.aiBookingEnabled);
    const activeAppointmentLeadIds = await Appointment.distinct("lead", {
      business: business._id,
      lead: { $ne: null },
      status: { $in: ["held", "confirmed"] },
    });
    const readyToScheduleLeadIds = autoBookingEnabled
      ? []
      : await Lead.distinct("_id", {
          business: business._id,
          status: { $in: ["new", "contacted"] },
          serviceNeeded: { $nin: ["", "Unknown"] },
          address: { $nin: ["", null] },
          preferredAppointmentTime: { $nin: ["", null] },
          _id: {
            $nin: [...needsMeLeadIds, ...activeAppointmentLeadIds],
          },
        });

    const filter = { business: business._id };
    if (normalizedView === "active") {
      filter.status = { $in: ["new", "contacted"] };
    } else if (normalizedView === "ready") {
      filter.status = { $in: ["new", "contacted"] };
      filter._id = { $in: readyToScheduleLeadIds };
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
          ready: [
            {
              $match: {
                status: { $in: ["new", "contacted"] },
                _id: { $in: readyToScheduleLeadIds },
              },
            },
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
    const readyToScheduleCount = count("ready");
    const waitingCount = count("waiting");
    const needsMeCount = count("needsMe");

    if (!leads.length) {
      return {
        items: [],
        stats: {
          active: activeCount,
          readyToSchedule: readyToScheduleCount,
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
          "lead status startAt endAt timezone source bookedBy provider confirmedAt customerConfirmedAt estimatedValue actualRevenue requiresBusinessApproval failureReason createdAt",
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
          business,
          lead,
          conversation: conversationByLead.get(String(lead._id)) || null,
          appointment: appointmentByLead.get(String(lead._id)) || null,
          hasOpenIntervention: openInterventionLeadSet.has(String(lead._id)),
        }),
      )
      .sort((a, b) => {
        const actionRank = {
          exception: 6,
          schedule: 5,
          approval: 5,
          customer: 4,
          automation: 3,
          appointment: 2,
          complete: 1,
        };
        const actionDifference =
          (actionRank[b.nextAction?.kind] || 0) -
          (actionRank[a.nextAction?.kind] || 0);
        if (actionDifference) return actionDifference;
        const urgency = (URGENCY_RANK[b.urgency] || 0) - (URGENCY_RANK[a.urgency] || 0);
        if (urgency) return urgency;
        return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
      });

    return {
      items,
      stats: {
        active: activeCount,
        readyToSchedule: readyToScheduleCount,
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
  nextActionFor,
  bookingEvidence,
  serializeOpportunity,
  resolveOwnerPeriod,
};
export default OwnerExperienceService;
