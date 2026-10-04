import { lifecycleMarker, tryRepairAppointmentLifecycle, repairPendingAppointmentLifecycles } from './appointmentLifecycle.service.js';
import { repairRescheduleReviews } from './rescheduleRequest.service.js';
import { normalizeAppointmentAddress as normalizeAddress } from './appointmentAddress.service.js';
import { ensureBusinessApprovalNotice, repairConfirmedApproval } from './appointmentConfirmation.service.js';
import { runApprovalSms } from './approvalSms.service.js';
import { arrivalWindow, customerAppointmentLabel } from './customerAppointmentPresentation.service.js';
import { reconcileApprovalRequests, resolveApprovalReview } from './approvalLifecycle.service.js';
import { withDistributedLease, assertDistributedLeaseActive } from '../distributedLease.service.js';
import { currentStaffSchedulingException, withStaffSchedulingException } from './staffSchedulingException.service.js';
import { assertServiceRequestEligible } from '../serviceEligibility/serviceEligibility.service.js';
import { safeConsole } from "../../helpers/logging/safeLogger.js";
import { resolveOpportunityValue, ownerEstimate, moneyAmount } from "../valuation/opportunityValue.js";
import crypto from "crypto";

import mongoose from "mongoose";
import Appointment from "../../models/appointment.js";
import { normalizePhoneToE164 } from "../../voice/voicePhone.service.js";
import CallLog from "../../models/callLog.js"; // CALLBACKIQ_MARKETING_ATTRIBUTION_V1
import Conversation from "../../models/conversation.js";
import Lead from "../../models/lead.js";
import ServiceOffering from "../../models/serviceOffering.js";
import AlertService from "../alert.service.js";
import AutomationTriggerService from "../automation/automationTrigger.service.js";
import ConversionEventService from "../conversionEvent.service.js";
import InterventionService from "../intervention.service.js";
import SocketService from "../socket.service.js";
import AvailabilityService from "./availability.service.js";
import {
  getAiBookableService,
  getBookableService,
  getSlotCapacity,
  getSchedulingPolicy,
} from "./appointmentPolicy.service.js";
import SchedulingProviderFactory from "./schedulingProviderFactory.js";
import { businessCalendarProviderName } from "./calendarProviderName.service.js";
import {
  cancelAppointmentNotifications,
  scheduleAppointmentReminders,
  schedulePostAppointmentFollowUp,
} from "./appointmentNotification.service.js";
import { addMinutes, formatDateKey } from "./timezone.service.js";

const ACTIVE_STATUSES = new Set(["held", "confirmed"]);
const VALID_TRANSITIONS = {
  held: new Set(["confirmed", "failed", "canceled"]),
  confirmed: new Set(["canceled", "completed", "no_show", "rescheduled"]),
  canceled: new Set(),
  completed: new Set(),
  no_show: new Set(),
  failed: new Set(),
  rescheduled: new Set(),
};




export { ensureBusinessApprovalNotice } from './appointmentConfirmation.service.js';

const getSlotKey = (startAt, endAt) =>
  `${new Date(startAt).toISOString()}|${new Date(endAt).toISOString()}`;

const getSlotClaimKeys = ({
  startAt,
  endAt,
  bufferBeforeMinutes = 0,
  bufferAfterMinutes = 0,
  capacityLane,
}) => {
  const minuteMs = 60_000;
  const claimStart =
    Math.floor(
      (new Date(startAt).getTime() - Number(bufferBeforeMinutes || 0) * minuteMs) /
        minuteMs,
    ) * minuteMs;
  const claimEnd =
    Math.ceil(
      (new Date(endAt).getTime() + Number(bufferAfterMinutes || 0) * minuteMs) /
        minuteMs,
    ) * minuteMs;
  const keys = [];

  for (let cursor = claimStart; cursor < claimEnd; cursor += minuteMs) {
    keys.push(`${new Date(cursor).toISOString()}|lane:${capacityLane}`);
  }

  return keys;
};

const assertTransition = (from, to) => {
  if (!VALID_TRANSITIONS[from]?.has(to)) {
    const error = new Error(`Invalid appointment transition: ${from} → ${to}`);
    error.statusCode = 409;
    error.code = "INVALID_APPOINTMENT_TRANSITION";
    throw error;
  }
};

const getAppointmentForBusiness = async (businessId, appointmentId) => {
  const appointment = await Appointment.findOne({
    _id: appointmentId,
    business: businessId,
  });

  if (!appointment) {
    const error = new Error("Appointment not found.");
    error.statusCode = 404;
    throw error;
  }

  return appointment;
};

const runNonBlockingAppointmentSideEffect = async ({
  appointment,
  businessId,
  label,
  task,
}) => {
  try {
    return await task();
  } catch (error) {
    safeConsole.error(`Appointment ${label} side effect failed:`, {
      appointmentId: String(appointment?._id || ""),
      businessId: String(businessId || appointment?.business || ""),
      error: error.message,
    });

    try {
      await InterventionService.create({
        businessId: businessId || appointment?.business,
        leadId: appointment?.lead || null,
        conversationId: appointment?.conversation || null,
        appointmentId: appointment?._id || null,
        type: "integration_failure",
        title: "Appointment notification follow-up needed",
        message: `The appointment was saved, but CallBackIQ could not complete the ${label} notification task.`,
        priority: "medium",
        reason: error.message,
        recommendedAction:
          "Review the appointment and contact the customer manually if needed.",
        metadata: { operation: label },
        dedupeKey: `appointment_side_effect:${label}:${appointment?._id || "unknown"}`,
      });
    } catch {
      // Never let an alerting failure reverse a durable appointment change.
    }

    return null;
  }
};

const exactSlotAvailable = async ({
  business,
  serviceOfferingId,
  startAt,
  endAt,
  postalCode,
  excludeAppointmentId,
  providerNameOverride = null,
  approvedExistingRequest = false,
}) => {
  const timeZone = business.timezone || "America/New_York";
  const dateKey = formatDateKey(startAt, timeZone);
  const lookup = () => AvailabilityService.getAvailability({
    business,
    serviceOfferingId,
    startDate: dateKey,
    endDate: dateKey,
    postalCode,
    excludeAppointmentId,
    providerNameOverride,
  });
  // The customer satisfied notice when requesting this exact time. A staff
  // decision must recheck current capacity, hours and calendar conflicts without
  // invalidating notice merely because time elapsed while awaiting approval.
  const result = approvedExistingRequest ? await withStaffSchedulingException({
    businessId: String(business._id), serviceOfferingId: String(serviceOfferingId), startAt,
    reason: 'Existing customer request: notice was checked when the slot was requested.',
  }, lookup) : await lookup();

  return result.slots.some(
    (slot) =>
      new Date(slot.startAt).getTime() === new Date(startAt).getTime() &&
      new Date(slot.endAt).getTime() === new Date(endAt).getTime(),
  );
};

const emptyAppointmentAttribution = () => ({
  marketingSource: null,
  trackingNumber: null,
  attribution: {},
});

const resolveAppointmentAttribution = async ({ businessId, input }) => {
  if (input?.marketingSource || input?.trackingNumber || input?.attribution) {
    return {
      marketingSource: input.marketingSource || null,
      trackingNumber: input.trackingNumber || null,
      attribution: input.attribution || {},
    };
  }

  /*
   * Marketing attribution is supplemental booking metadata.
   * It must never block appointment creation, confirmation, or rescheduling.
   *
   * Unit tests and some internal callers intentionally use synthetic IDs such
   * as "b1" and "l1". Do not send those through ObjectId-backed CallLog
   * queries.
   */
  if (!mongoose.isValidObjectId(businessId)) {
    return emptyAppointmentAttribution();
  }

  const filter = {
    business: businessId,
    marketingSource: { $ne: null },
  };

  if (input?.lead) {
    if (!mongoose.isValidObjectId(input.lead)) {
      return emptyAppointmentAttribution();
    }

    filter.lead = input.lead;
  } else if (input?.customerPhone) {
    const normalizedCustomerPhone = normalizePhoneToE164(input.customerPhone);
    if (!normalizedCustomerPhone) {
      return { marketingSource: null, trackingNumber: null, attribution: {} };
    }
    filter.from = normalizedCustomerPhone;
  } else {
    return emptyAppointmentAttribution();
  }

  const call = await CallLog.findOne(filter)
    .sort({ createdAt: -1 })
    .select("marketingSource trackingNumber attribution")
    .lean();

  if (!call && input?.lead) {
    const attributedLead = await Lead.findOne({ _id: input.lead, business: businessId })
      .select('firstMarketingSource firstTrackingNumber firstAttribution latestMarketingSource latestTrackingNumber latestAttribution').lean();
    if (attributedLead?.firstMarketingSource || attributedLead?.latestMarketingSource) {
      const first = Boolean(attributedLead.firstMarketingSource);
      return { marketingSource: first ? attributedLead.firstMarketingSource : attributedLead.latestMarketingSource,
        trackingNumber: (first ? attributedLead.firstTrackingNumber : attributedLead.latestTrackingNumber) || null,
        attribution: (first ? attributedLead.firstAttribution : attributedLead.latestAttribution) || {} };
    }
  }

  return {
    marketingSource: call?.marketingSource || null,
    trackingNumber: call?.trackingNumber || null,
    attribution: call?.attribution || {},
  };
};

const createHold = async ({
  business,
  service,
  input,
  idempotencyKey,
  excludeAppointmentId = null,
  checkExternalAvailability = true,
  ownerValuationAuthorized = false,
  preservedValuation = null,
}) => {
  const businessId = business._id;
  const startAt = new Date(input.startAt);
  // exactSlotAvailable below rechecks the authoritative business/service policy.
  const endAt = input.endAt
    ? new Date(input.endAt)
    : addMinutes(startAt, Number(service.durationMinutes || 90));
  const address = normalizeAddress(input.address);
  const available = await exactSlotAvailable({
    business,
    serviceOfferingId: service._id,
    startAt,
    endAt,
    postalCode: address.postalCode,
    excludeAppointmentId,
    providerNameOverride: checkExternalAvailability ? null : "internal",
  });

  if (!available) {
    const error = new Error("The selected appointment time is no longer available.");
    error.statusCode = 409;
    error.code = "SLOT_UNAVAILABLE";
    throw error;
  }

  const appointmentAttribution = await resolveAppointmentAttribution({
    businessId,
    input,
  });
  const timeZone = input.timezone || business.timezone || "America/New_York";
  const capacity = await getSlotCapacity({
    businessId,
    startAt,
    timeZone,
  });
  const valuationLead = input.lead ? await Lead.findOne({ _id: input.lead, business: businessId }).lean() : null;
  const appointmentValue = preservedValuation || (ownerValuationAuthorized === true && Object.prototype.hasOwnProperty.call(input, "estimatedValue")
    ? ownerEstimate(input.estimatedValue)
    : resolveOpportunityValue({ businessId, current: valuationLead, services: [service],
        selectedServiceId: ownerValuationAuthorized === true ? service._id : null,
        evidence: valuationLead?.serviceNeeded || "" }));
  const baseDocument = {
    business: businessId,
    lead: input.lead || null,
    conversation: input.conversation || null,
    serviceOffering: service._id,
    customerName: input.customerName || "Customer",
    customerPhone: input.customerPhone,
    customerEmail: input.customerEmail || "",
    address,
    startAt,
    endAt,
    timezone: timeZone,
    bufferBeforeMinutes: service.bufferBeforeMinutes || 0,
    bufferAfterMinutes: service.bufferAfterMinutes || 0,
    status: "held",
    source: input.source || "manual",
    bookedBy: input.bookedBy || "staff",
    marketingSource: appointmentAttribution.marketingSource,
    trackingNumber: appointmentAttribution.trackingNumber,
    attribution: appointmentAttribution.attribution,
    provider: businessCalendarProviderName(business),
    ...appointmentValue,
    actualRevenue: input.actualRevenue || 0,
    idempotencyKey,
    heldExpiresAt: addMinutes(new Date(), Number(input.holdMinutes || 5)),
    automaticConfirmationAuthorized: input.automaticConfirmationAuthorized === true,
    ...arrivalWindow(startAt, timeZone, await getSchedulingPolicy(businessId)),
    requiresBusinessApproval: input.requiresBusinessApproval === true,
    approvalRequestedAt:
      input.requiresBusinessApproval === true ? new Date() : null,
    notes: input.notes || "",
    schedulingException: currentStaffSchedulingException({ businessId, serviceOfferingId: service._id, startAt }),
  };

  for (let capacityLane = 1; capacityLane <= capacity; capacityLane += 1) {
    try {
      return await Appointment.create({
        ...baseDocument,
        capacityLane,
        activeSlotKey: `${getSlotKey(startAt, endAt)}|lane:${capacityLane}`,
        slotClaimKeys: getSlotClaimKeys({
          startAt,
          endAt,
          bufferBeforeMinutes: baseDocument.bufferBeforeMinutes,
          bufferAfterMinutes: baseDocument.bufferAfterMinutes,
          capacityLane,
        }),
      });
    } catch (error) {
      if (error?.code !== 11000) {
        throw error;
      }

      const existing = await Appointment.findOne({
        business: businessId,
        idempotencyKey,
      });
      if (existing) return existing;
    }
  }

  const conflict = new Error("Another customer claimed this appointment time.");
  conflict.statusCode = 409;
  conflict.code = "SLOT_ALREADY_CLAIMED";
  throw conflict;
};

const populateAppointment = (query) =>
  query
    .populate("serviceOffering", "name category durationMinutes estimatedValue")
    .populate(
      "lead",
      "customerName phone email address serviceNeeded urgency status source recovered recoveredBy summary preferredAppointmentTime qualifiedAt firstRespondedAt bookedAt estimatedValue valuation actualRevenue firstAttribution latestAttribution",
    )
    .populate(
      "conversation",
      "customerPhone customerName status humanTakeover bookingState conversationMemory lastMessage lastMessageAt",
    )
    .populate("rescheduledFrom", "startAt endAt status")
    .populate("rescheduledTo", "startAt endAt status");

const ensureCancellationSideEffects = async ({
  business,
  appointment,
  reason = "",
}) => {
  await runNonBlockingAppointmentSideEffect({
    appointment,
    businessId: business._id,
    label: "cancellation conversion event",
    task: () =>
      ConversionEventService.record({
        businessId: business._id,
        leadId: appointment.lead,
        conversationId: appointment.conversation,
        appointmentId: appointment._id,
        type: "appointment_canceled",
        channel: appointment.source,
        estimatedValue: appointment.estimatedValue,
        idempotencyKey: `appointment_canceled:${appointment._id}`,
        metadata: { reason },
      }),
  });

  await runNonBlockingAppointmentSideEffect({
    appointment,
    businessId: business._id,
    label: "cancellation intervention",
    task: () =>
      InterventionService.create({
        businessId: business._id,
        leadId: appointment.lead,
        conversationId: appointment.conversation,
        appointmentId: appointment._id,
        type: "appointment_canceled",
        title: "Appointment canceled",
        message:
          "A confirmed appointment was canceled and may need recovery follow-up.",
        priority: "medium",
        recommendedAction: "Offer the customer a new appointment time.",
        dedupeKey: `appointment_canceled:${appointment._id}`,
      }),
  });

  if (appointment.conversation) {
    await runNonBlockingAppointmentSideEffect({
      appointment,
      businessId: business._id,
      label: "canceled appointment recovery automation",
      task: () =>
        AutomationTriggerService.schedule({
          businessId: business._id,
          trigger: "canceled_appointment_recovery",
          leadId: appointment.lead,
          conversationId: appointment.conversation,
          appointmentId: appointment._id,
          triggerInstanceId: String(appointment._id),
          occurredAt: appointment.canceledAt,
        }),
    });
  }
};

class AppointmentService {
  static async releaseExpiredHolds(businessId = null) {
    const query = {
      status: "held",
      heldExpiresAt: { $lte: new Date() },
      ...(businessId ? { business: businessId } : {}),
    };

    const result = await Appointment.updateMany(query, {
      $set: {
        status: "failed",
        activeSlotKey: null,
        slotClaimKeys: [],
        capacityLane: null,
        failureReason: "Appointment hold expired before confirmation.",
        "approvalRecovery.reconciled": false,
        "approvalRecovery.expiredAt": new Date(),
      },
    });
    await reconcileApprovalRequests({ businessId });
    await repairPendingAppointmentLifecycles({ businessId });
    await repairRescheduleReviews({ businessId });
    await runApprovalSms();
    return result;
  }

  static async recheckAndConfirm({ business, appointmentId, approvedBy }) {
    if (!approvedBy) throw Object.assign(new Error('Staff approval is required.'), { statusCode: 403 });
    const lease = await withDistributedLease(`appointment-approval:${appointmentId}`, async () => {
      let appointment = await getAppointmentForBusiness(business._id, appointmentId);
      if (appointment.status === 'confirmed') {
        await repairConfirmedApproval({ appointment, business });
        return appointment;
      }
      if (!(appointment.status === 'held' || (appointment.requiresBusinessApproval === true && appointment.status === 'failed' && /hold expired/i.test(appointment.failureReason)))) {
        throw Object.assign(new Error('This appointment is not awaiting approval.'), { statusCode: 409 });
      }
      if (appointment.status === 'held' && appointment.heldExpiresAt > new Date()) return this.confirm({ business, appointmentId, approvedBy });
      const available = await exactSlotAvailable({ business, serviceOfferingId: appointment.serviceOffering,
        startAt: appointment.startAt, endAt: appointment.endAt, postalCode: appointment.address?.postalCode, excludeAppointmentId: appointment._id, approvedExistingRequest: true });
      if (!available) throw Object.assign(new Error('That time is no longer available. Contact the customer to agree another time.'), { statusCode: 409, code: 'SLOT_UNAVAILABLE' });
      const capacity = await getSlotCapacity({ businessId: business._id, startAt: appointment.startAt, timeZone: appointment.timezone });
      let claimed = false;
      for (let lane = 1; lane <= capacity; lane++) {
        try {
          assertDistributedLeaseActive();
          appointment = await Appointment.findOneAndUpdate({ _id: appointment._id, business: business._id,
            status: appointment.status }, { $set: { status: 'held', heldExpiresAt: addMinutes(new Date(), 5),
            failureReason: '', capacityLane: lane, activeSlotKey: `${getSlotKey(appointment.startAt, appointment.endAt)}|lane:${lane}`,
            slotClaimKeys: getSlotClaimKeys({ ...appointment.toObject(), capacityLane: lane }),
            'approvalRecovery.reconciled': false, 'approvalRecovery.state': 'pending',
          } }, { new: true, runValidators: true });
          if (!appointment) throw Object.assign(new Error('The request changed. Reload it before approving.'), { statusCode: 409 });
          claimed = true; break;
        } catch (error) { if (error.code !== 11000) throw error; }
      }
      if (!claimed) throw Object.assign(new Error('Another customer claimed that time.'), { statusCode: 409 });
      return this.confirm({ business, appointmentId, approvedBy });
    });
    if (!lease.acquired) throw Object.assign(new Error('Another approval is being processed. Reload this request.'), { statusCode: 409 });
    return lease.value;
  }

  static async create({ business, input, idempotencyKey, confirm = true, ownerValuationAuthorized = false }) {
    if (input.address !== undefined) normalizeAddress(input.address);
    if (ownerValuationAuthorized && Object.prototype.hasOwnProperty.call(input, "estimatedValue") && input.estimatedValue !== null && moneyAmount(input.estimatedValue) === null) {
      const error = new Error("Estimated value must be null or a non-negative number."); error.statusCode = 400; throw error;
    }
    if (!input.customerPhone) {
      const error = new Error("customerPhone is required.");
      error.statusCode = 400;
      throw error;
    }

    const key = String(
      idempotencyKey || input.idempotencyKey || crypto.randomUUID(),
    ).trim();
    const existing = await Appointment.findOne({
      business: business._id,
      idempotencyKey: key,
    });
    if (existing) {
      if (existing.status === "confirmed") { await tryRepairAppointmentLifecycle(existing, business); return existing; }

      if (existing.status === "held") {
        if (existing.requiresBusinessApproval === true || !confirm) {
          return existing;
        }
        return this.confirm({
          business,
          appointmentId: existing._id,
        });
      }

      const error = new Error(
        `The prior appointment operation already finished in state "${existing.status}". Re-check availability before trying again.`,
      );
      error.statusCode = 409;
      error.code = "APPOINTMENT_IDEMPOTENCY_REPLAY_FINAL_STATE";
      error.existingStatus = existing.status;
      throw error;
    }

    const serviceResolver =
      input.bookedBy === "ai" ? getAiBookableService : getBookableService;
    const service = await serviceResolver({
      businessId: business._id,
      serviceOfferingId: input.serviceOfferingId || input.serviceOffering,
    });
    if (input.bookedBy === 'ai' || input.conversation || input.lead) await assertServiceRequestEligible({ businessId: business._id,
      leadId: input.lead, conversationId: input.conversation, serviceOfferingId: service._id,
      request: input.serviceQuery, allowStaffReview: input.bookedBy !== 'ai' });
    const hold = await createHold({
      business,
      service,
      input,
      ownerValuationAuthorized,
      idempotencyKey: key,
      // Immediate Google confirmations perform one external availability check
      // at confirm time. The internal claim index still protects the hold.
      checkExternalAvailability:
        !confirm || businessCalendarProviderName(business) !== "google_calendar",
    });

    if (!confirm || hold.status !== "held") {
      if (hold.requiresBusinessApproval) {
        SocketService.emitToBusiness(
          business._id,
          "appointment:approval_requested",
          hold,
        );
        SocketService.emitDashboardRefresh(
          business._id,
          "appointment_approval_requested",
        );
      }
      return hold;
    }

    return this.confirm({ business, appointmentId: hold._id });
  }

  static async confirm({ business, appointmentId, approvedBy = null }) {
    const appointment = await getAppointmentForBusiness(
      business._id,
      appointmentId,
    );

    if (appointment.status === "confirmed") { await tryRepairAppointmentLifecycle(appointment, business); return appointment; }
    assertTransition(appointment.status, "confirmed");

    if (appointment.heldExpiresAt && appointment.heldExpiresAt <= new Date()) {
      appointment.status = "failed";
      appointment.activeSlotKey = null;
      appointment.slotClaimKeys = [];
      appointment.capacityLane = null;
      appointment.failureReason = "The appointment hold expired before confirmation.";
      appointment.approvalRecovery = { ...(appointment.approvalRecovery?.toObject?.() || appointment.approvalRecovery || {}), reconciled: false, expiredAt: new Date() };
      await appointment.save();
      const error = new Error("The appointment hold expired.");
      error.statusCode = 409;
      error.code = "HOLD_EXPIRED";
      throw error;
    }

    if (appointment.bookedBy === 'ai' || appointment.conversation) await assertServiceRequestEligible({ businessId: business._id,
      leadId: appointment.lead, conversationId: appointment.conversation, serviceOfferingId: appointment.serviceOffering,
      allowStaffReview: Boolean(approvedBy) });
    const stillAvailable = await exactSlotAvailable({
      business,
      serviceOfferingId: appointment.serviceOffering,
      startAt: appointment.startAt,
      endAt: appointment.endAt,
      postalCode: appointment.address?.postalCode,
      excludeAppointmentId: appointment._id,
      approvedExistingRequest: Boolean(approvedBy),
    });

    if (!stillAvailable) {
      appointment.status = "failed";
      appointment.activeSlotKey = null;
      appointment.slotClaimKeys = [];
      appointment.capacityLane = null;
      appointment.failureReason =
        "The slot was unavailable during the final availability check.";
      await appointment.save();
      const error = new Error("The selected appointment time is no longer available.");
      error.statusCode = 409;
      error.code = "SLOT_UNAVAILABLE";
      throw error;
    }

    const [service, lead] = await Promise.all([
      ServiceOffering.findById(appointment.serviceOffering),
      appointment.lead ? Lead.findById(appointment.lead) : null,
    ]);
    const provider = SchedulingProviderFactory.getProvider(business);
    let providerResult = null;

    try {
      assertDistributedLeaseActive();
      providerResult = await provider.createAppointment({
        appointment,
        service,
      });
      appointment.provider = providerResult.provider || appointment.provider;
      appointment.externalAppointmentId =
        providerResult.externalAppointmentId || null;
      appointment.externalCalendarId =
        providerResult.externalCalendarId || null;
      appointment.status = "confirmed";
      if (!appointment.requiresBusinessApproval && !appointment.automaticConfirmationAuthorized && appointment.bookedBy !== "ai") appointment.lifecycleNotice = lifecycleMarker("confirmed");
      appointment.approvalRecovery = { state: "resolved", reconciled: false };
      appointment.confirmedAt = new Date();
      appointment.heldExpiresAt = null;
      appointment.failureReason = "";
      if (appointment.requiresBusinessApproval) {
        appointment.approvalDecisionAt = new Date();
        appointment.approvalDecisionBy = approvedBy || null;
        appointment.approvalDeclineReason = "";
      }
      await appointment.save();
    } catch (error) {
      // If Google accepted the insert but MongoDB did not persist confirmation,
      // remove the event immediately so the business does not inherit an orphan.
      if (providerResult?.externalAppointmentId) {
        try {
          await provider.cancelAppointment({
            appointment: {
              ...appointment.toObject(),
              externalAppointmentId: providerResult.externalAppointmentId,
              externalCalendarId: providerResult.externalCalendarId,
            },
            reason: "CallBackIQ rolled back an incomplete confirmation.",
          });
        } catch (cleanupError) {
          await InterventionService.create({
            businessId: business._id,
            leadId: appointment.lead,
            conversationId: appointment.conversation,
            appointmentId: appointment._id,
            type: "integration_failure",
            title: "Google Calendar event needs cleanup",
            message:
              "Google created an event, but CallBackIQ could not persist the matching appointment or remove the event automatically.",
            priority: "high",
            reason: cleanupError.message,
            recommendedAction:
              "Remove the orphaned Google event and retry the customer booking.",
            metadata: {
              provider: "google_calendar",
              googleEventId: providerResult.externalAppointmentId,
              googleCalendarId: providerResult.externalCalendarId,
            },
            dedupeKey: `google_orphan_cleanup:${appointment._id}:${providerResult.externalAppointmentId}`,
          });
        }
      }

      appointment.status = "failed";
      appointment.activeSlotKey = null;
      appointment.slotClaimKeys = [];
      appointment.capacityLane = null;
      appointment.heldExpiresAt = null;
      appointment.failureReason = error.message;
      try {
        await appointment.save();
      } catch {
        // Preserve the original provider/persistence error for the caller.
      }
      await InterventionService.integrationFailure({
        businessId: business._id,
        leadId: appointment.lead,
        conversationId: appointment.conversation,
        appointmentId: appointment._id,
        provider: appointment.provider || "internal",
        error,
      });
      error.safeCustomerMessage =
        "I’m having trouble confirming that appointment right now. I’ve sent your request to the team so they can confirm it directly.";
      throw error;
    }

    await tryRepairAppointmentLifecycle(appointment, business);
    await resolveApprovalReview(appointment).catch(() => {});
    // Confirmation is durable at this point. Secondary notifications and
    // analytics must never roll the appointment back if they fail.
    if (appointment.requiresBusinessApproval || appointment.automaticConfirmationAuthorized) {
      await runNonBlockingAppointmentSideEffect({
        appointment,
        businessId: business._id,
        label: "business approval customer confirmation",
        task: async () => {
          await ensureBusinessApprovalNotice({ appointment, business, service });
          if (appointment.conversation) {
            await Conversation.updateOne(
              { _id: appointment.conversation, business: business._id },
              {
                $set: {
                  "bookingState.status": "booked",
                  "bookingState.appointment": appointment._id,
                  "bookingState.expiresAt": null,
                  "bookingState.lastError": "",
                },
              },
            );
          }
        },
      });
    }

    try {
      await scheduleAppointmentReminders({ appointment });
    } catch (error) {
      await InterventionService.create({
        businessId: business._id,
        leadId: appointment.lead,
        conversationId: appointment.conversation,
        appointmentId: appointment._id,
        type: "integration_failure",
        title: "Appointment reminders were not scheduled",
        message:
          "The appointment is confirmed, but CallBackIQ could not schedule its customer reminders.",
        priority: "medium",
        reason: error.message,
        recommendedAction:
          "Confirm reminder settings and contact the customer manually if needed.",
        metadata: { provider: appointment.provider || "internal" },
        dedupeKey: `appointment_reminder_schedule:${appointment._id}`,
      });
    }

    try {
      await ConversionEventService.markAppointmentBooked({
        appointment,
        lead,
        channel: appointment.source,
        bookedBy: appointment.bookedBy,
      });
      if (appointment.lead) {
        await AlertService.createBookedJobAlert({
          businessId: business._id,
          leadId: appointment.lead,
          customerName: appointment.customerName,
          customerPhone: appointment.customerPhone,
          serviceNeeded:
            service?.name || lead?.serviceNeeded || "Service appointment",
          estimatedValue: appointment.estimatedValue,
        });
      }
    } catch (error) {
      safeConsole.error("Appointment confirmation side effect failed:", {
        appointmentId: String(appointment._id),
        error: error.message,
      });
    }

    SocketService.emitToBusiness(
      business._id,
      "appointment:confirmed",
      appointment,
    );
    SocketService.emitDashboardRefresh(
      business._id,
      "appointment_confirmed",
    );
    return appointment;
  }

  static async decline({
    business,
    appointmentId,
    reason = "The requested time could not be accepted.",
    declinedBy = null,
  }) {
    const appointment = await getAppointmentForBusiness(
      business._id,
      appointmentId,
    );

    if (appointment.status === 'failed' && appointment.approvalDecisionAt && appointment.lifecycleNotice?.key === 'lifecycle_declined') {
      await tryRepairAppointmentLifecycle(appointment, business);
      return appointment;
    }
    if (
      (appointment.status !== "held" && !(appointment.status === "failed" && /hold expired/i.test(appointment.failureReason || ""))) ||
      appointment.requiresBusinessApproval !== true
    ) {
      const error = new Error(
        "Only appointment requests awaiting business approval can be declined.",
      );
      error.statusCode = 409;
      error.code = "APPOINTMENT_NOT_AWAITING_APPROVAL";
      throw error;
    }

    appointment.lifecycleNotice = lifecycleMarker("declined");
    appointment.status = "failed";
    appointment.activeSlotKey = null;
    appointment.slotClaimKeys = [];
    appointment.capacityLane = null;
    appointment.heldExpiresAt = null;
    appointment.approvalRecovery = { state: "resolved", reconciled: false };
    appointment.approvalDecisionAt = new Date();
    appointment.approvalDecisionBy = declinedBy || null;
    appointment.approvalDeclineReason = String(reason || "").trim();
    appointment.failureReason =
      appointment.approvalDeclineReason || "Appointment request declined.";
    await appointment.save();
    await resolveApprovalReview(appointment).catch(() => {});

    await tryRepairAppointmentLifecycle(appointment, business);

    SocketService.emitToBusiness(
      business._id,
      "appointment:declined",
      appointment,
    );
    SocketService.emitDashboardRefresh(
      business._id,
      "appointment_declined",
    );
    return appointment;
  }

  static async cancel({ business, appointmentId, reason = "", notifyCustomer = true }) {
    const appointment = await getAppointmentForBusiness(
      business._id,
      appointmentId,
    );

    // A retry after the durable local transition replays idempotent side
    // effects instead of silently skipping anything that previously failed.
    if (appointment.status === "canceled") {
      await tryRepairAppointmentLifecycle(appointment, business);
      await resolveApprovalReview(appointment).catch(() => {});
      await runNonBlockingAppointmentSideEffect({
        appointment,
        businessId: business._id,
        label: "cancellation reminder cleanup",
        task: () =>
          cancelAppointmentNotifications({
            businessId: business._id,
            appointmentId: appointment._id,
            reason: "Appointment canceled.",
            types: ["reminder", "follow_up"],
          }),
      });
      await ensureCancellationSideEffects({
        business,
        appointment,
        reason,
      });
      return appointment;
    }

    assertTransition(appointment.status, "canceled");
    const provider = SchedulingProviderFactory.getProvider(
      business,
      appointment.provider || "internal",
    );

    try {
      // Provider cancellation is required to be idempotent. Google Calendar
      // already treats a missing (404) event as canceled.
      await provider.cancelAppointment({ appointment, reason });
    } catch (error) {
      await InterventionService.integrationFailure({
        businessId: business._id,
        leadId: appointment.lead,
        conversationId: appointment.conversation,
        appointmentId: appointment._id,
        provider: appointment.provider || "internal",
        error,
      });
      throw error;
    }

    if (notifyCustomer) appointment.lifecycleNotice = lifecycleMarker("canceled");
    if (appointment.rescheduleRequest?.status === 'pending') {
      appointment.rescheduleRequest.status = 'canceled';
      appointment.rescheduleRequest.alertPending = true;
    }
    appointment.status = "canceled";
    appointment.approvalRecovery = { state: "resolved", reconciled: false };
    appointment.canceledAt = appointment.canceledAt || new Date();
    appointment.activeSlotKey = null;
    appointment.slotClaimKeys = [];
    appointment.capacityLane = null;
    appointment.notes = [
      appointment.notes,
      reason ? `Cancellation: ${reason}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // If this save fails after the provider delete, the appointment remains
    // locally confirmed. Retrying the endpoint is safe because provider
    // cancellation is idempotent and will reach this save again.
    await appointment.save();
    await tryRepairAppointmentLifecycle(appointment, business);
    await resolveApprovalReview(appointment).catch(() => {});

    await runNonBlockingAppointmentSideEffect({
      appointment,
      businessId: business._id,
      label: "cancellation reminder cleanup",
      task: () =>
        cancelAppointmentNotifications({
          businessId: business._id,
          appointmentId: appointment._id,
          reason: "Appointment canceled.",
            types: ["reminder", "follow_up"],
        }),
    });

    await ensureCancellationSideEffects({
      business,
      appointment,
      reason,
    });

    SocketService.emitToBusiness(
      business._id,
      "appointment:canceled",
      appointment,
    );
    SocketService.emitDashboardRefresh(
      business._id,
      "appointment_canceled",
    );
    return appointment;
  }

  static async reschedule({
    business,
    appointmentId,
    input,
    idempotencyKey,
  }) {
    if (input.address !== undefined) normalizeAddress(input.address);
    const original = await getAppointmentForBusiness(
      business._id,
      appointmentId,
    );
    if (input.requestId && (original.rescheduleRequest?.id !== input.requestId ||
        !['pending', 'approved'].includes(original.rescheduleRequest?.status) ||
        +new Date(original.rescheduleRequest.startAt) !== +new Date(input.startAt) ||
        +new Date(original.rescheduleRequest.endAt) !== +new Date(input.endAt))) {
      throw Object.assign(new Error('The customer request changed. Reload before approving.'), { statusCode: 409 });
    }
    const key = String(
      idempotencyKey ||
        input.idempotencyKey ||
        `reschedule:${original._id}:${crypto.randomUUID()}`,
    ).trim();

    let replacement = await Appointment.findOne({
      business: business._id,
      idempotencyKey: key,
    });

    if (
      replacement &&
      replacement.rescheduledFrom &&
      String(replacement.rescheduledFrom) !== String(original._id)
    ) {
      const error = new Error(
        "The idempotency key belongs to a different reschedule operation.",
      );
      error.statusCode = 409;
      error.code = "RESCHEDULE_IDEMPOTENCY_CONFLICT";
      throw error;
    }

    if (replacement && !replacement.rescheduledFrom && replacement.status === "held") {
      replacement.rescheduledFrom = original._id;
      await replacement.save();
    }

    const reconcileOriginal = async () => {
      if (original.status === "rescheduled") return;
      assertTransition(original.status, "rescheduled");
      if (original.rescheduleRequest?.status === 'pending') {
        original.rescheduleRequest.status = 'approved';
        original.rescheduleRequest.decidedAt = new Date();
        original.rescheduleRequest.alertPending = true;
      }
      original.status = "rescheduled";
      original.rescheduledTo = replacement._id;
      original.activeSlotKey = null;
      original.slotClaimKeys = [];
      original.capacityLane = null;
      original.externalAppointmentId = null;
      original.externalCalendarId = null;
      await original.save();
    };

    if (replacement?.status === "confirmed") {
      await reconcileOriginal();
      await tryRepairAppointmentLifecycle(replacement, business);
      return replacement;
    }

    if (replacement && replacement.status !== "held") {
      const error = new Error(
        `The prior reschedule operation cannot be replayed from state "${replacement.status}".`,
      );
      error.statusCode = 409;
      error.code = "RESCHEDULE_IDEMPOTENCY_FINAL_STATE";
      throw error;
    }

    if (original.status === "rescheduled") {
      if (original.rescheduledTo) {
        const existingReplacement = await Appointment.findOne({
          _id: original.rescheduledTo,
          business: business._id,
        });
        if (existingReplacement) { await tryRepairAppointmentLifecycle(existingReplacement, business); return existingReplacement; }
      }
      const error = new Error(
        "The appointment was already rescheduled but its replacement could not be resolved.",
      );
      error.statusCode = 409;
      error.code = "RESCHEDULE_REPLACEMENT_NOT_FOUND";
      throw error;
    }

    assertTransition(original.status, "rescheduled");

    const service = await getBookableService({
      businessId: business._id,
      serviceOfferingId: original.serviceOffering,
    });
    const nextInput = {
      ...input,
      serviceOfferingId: service._id,
      lead: original.lead,
      conversation: original.conversation,
      customerName: input.customerName || original.customerName,
      customerPhone: input.customerPhone || original.customerPhone,
      customerEmail: input.customerEmail || original.customerEmail,
      address: input.address || original.address,
      timezone: input.timezone || original.timezone,
      source: input.source || original.source,
      bookedBy: input.bookedBy || original.bookedBy,
      estimatedValue: original.estimatedValue,
      notes: input.notes || original.notes,
    };

    if (!replacement) {
      const available = await exactSlotAvailable({
        business,
        serviceOfferingId: service._id,
        startAt: nextInput.startAt,
        endAt:
          nextInput.endAt ||
          addMinutes(nextInput.startAt, service.durationMinutes),
        postalCode: nextInput.address?.postalCode,
        excludeAppointmentId: original._id,
      });

      if (!available) {
        const error = new Error(
          "The requested replacement time is unavailable.",
        );
        error.statusCode = 409;
        error.code = "SLOT_UNAVAILABLE";
        throw error;
      }

      replacement = await createHold({
        business,
        service,
        input: nextInput,
        preservedValuation: { estimatedValue: original.estimatedValue, valuation: original.valuation || { source: "legacy_unverified" } },
        idempotencyKey: key,
        excludeAppointmentId: original._id,
      });
      replacement.rescheduledFrom = original._id;
      await replacement.save();
    }

    const originalProviderName = original.provider || "internal";
    const provider = SchedulingProviderFactory.getProvider(
      business,
      originalProviderName,
    );

    /*
     * Provider-event ownership handoff
     * --------------------------------
     * A provider reschedule normally updates the SAME external calendar
     * event. The Appointment collection enforces a unique
     * (provider, externalAppointmentId) constraint, so the replacement
     * cannot claim that event while the original still owns it.
     *
     * The handoff is therefore staged durably:
     *
     *   1. Provider update succeeds.
     *   2. Provider IDs are persisted on non-unique pending fields.
     *   3. Original releases its unique provider linkage.
     *   4. Replacement claims the provider linkage and is confirmed.
     *   5. Original is finalized as rescheduled.
     *
     * If the process dies after step 3, a same-key replay recognizes the
     * staged provider ID and resumes locally without issuing a second
     * provider mutation.
     */
    const resumeProviderHandoff =
      replacement.status === "held" &&
      !original.externalAppointmentId &&
      Boolean(replacement.pendingRescheduleExternalAppointmentId);

    const replacementStateBeforeProvider = {
      status: replacement.status,
      confirmedAt: replacement.confirmedAt,
      heldExpiresAt: replacement.heldExpiresAt,
      externalAppointmentId: replacement.externalAppointmentId,
      externalCalendarId: replacement.externalCalendarId,
    };

    let stagedExternalAppointmentId =
      replacement.pendingRescheduleExternalAppointmentId || null;
    let stagedExternalCalendarId =
      replacement.pendingRescheduleExternalCalendarId || null;
    let providerApplied = resumeProviderHandoff;

    try {
      let providerResult;

      if (resumeProviderHandoff) {
        providerResult = {
          provider:
            replacement.provider || originalProviderName || "internal",
          externalAppointmentId: stagedExternalAppointmentId,
          externalCalendarId: stagedExternalCalendarId,
        };
      } else {
        // Provider PATCH is deliberately safe to replay with the same target
        // time. This closes the "provider succeeded / HTTP response was lost"
        // window.
        providerResult = await provider.updateAppointment({
          appointment: original,
          eventAppointment: replacement,
          changes: {
            startAt: replacement.startAt,
            endAt: replacement.endAt,
          },
          service,
        });
        providerApplied = true;

        stagedExternalAppointmentId =
          providerResult?.externalAppointmentId ||
          stagedExternalAppointmentId ||
          replacement.externalAppointmentId ||
          original.externalAppointmentId ||
          null;

        stagedExternalCalendarId =
          providerResult?.externalCalendarId ||
          stagedExternalCalendarId ||
          replacement.externalCalendarId ||
          original.externalCalendarId ||
          null;

        replacement.provider =
          providerResult?.provider ||
          replacement.provider ||
          originalProviderName ||
          "internal";

        /*
         * Persist the provider identity BEFORE releasing the original's
         * unique provider linkage. This is the durable recovery marker.
         */
        replacement.pendingRescheduleExternalAppointmentId =
          stagedExternalAppointmentId;
        replacement.pendingRescheduleExternalCalendarId =
          stagedExternalCalendarId;
        replacement.failureReason = "";
        await replacement.save();

        /*
         * Release only the provider-event uniqueness here. Keep the original
         * confirmed and keep its slot lineage intact until the replacement
         * has successfully claimed the provider event.
         *
         * If execution stops here, the staged replacement has enough durable
         * state for an idempotent same-key retry to finish the handoff.
         */
        original.externalAppointmentId = null;
        original.externalCalendarId = null;
        await original.save();
      }

      replacement.lifecycleNotice = lifecycleMarker("rescheduled");
      replacement.status = "confirmed";
      replacement.confirmedAt = replacement.confirmedAt || new Date();
      replacement.heldExpiresAt = null;
      replacement.provider =
        providerResult?.provider ||
        replacement.provider ||
        originalProviderName ||
        "internal";
      replacement.externalAppointmentId =
        providerResult?.externalAppointmentId ||
        stagedExternalAppointmentId ||
        replacement.externalAppointmentId ||
        null;
      replacement.externalCalendarId =
        providerResult?.externalCalendarId ||
        stagedExternalCalendarId ||
        replacement.externalCalendarId ||
        null;
      replacement.pendingRescheduleExternalAppointmentId = null;
      replacement.pendingRescheduleExternalCalendarId = null;
      replacement.failureReason = "";

      // The original has already released the unique event ID, so this claim
      // cannot collide with the original appointment.
      await replacement.save();

      // Complete lineage and release the original slot only after the
      // replacement durably owns the provider event.
      await reconcileOriginal();
    } catch (error) {
      /*
       * Restore the replacement to a retryable held state in memory before
       * attempting the reconciliation write. This prevents an error after a
       * provider update from accidentally persisting a half-confirmed local
       * appointment.
       */
      replacement.status = replacementStateBeforeProvider.status;
      replacement.confirmedAt = replacementStateBeforeProvider.confirmedAt;
      replacement.heldExpiresAt = replacementStateBeforeProvider.heldExpiresAt;
      replacement.externalAppointmentId =
        replacementStateBeforeProvider.externalAppointmentId || null;
      replacement.externalCalendarId =
        replacementStateBeforeProvider.externalCalendarId || null;

      if (providerApplied) {
        replacement.pendingRescheduleExternalAppointmentId =
          stagedExternalAppointmentId;
        replacement.pendingRescheduleExternalCalendarId =
          stagedExternalCalendarId;
      }

      replacement.failureReason = providerApplied
        ? `Provider update applied; local reconciliation required: ${error.message}`
        : `Provider update failed or outcome is uncertain; same-key retry required: ${error.message}`;

      try {
        await replacement.save();
      } catch {
        // Operational intervention below remains the final fallback.
      }

      try {
        await InterventionService.create({
          businessId: business._id,
          leadId: replacement.lead,
          conversationId: replacement.conversation,
          appointmentId: replacement._id,
          type: "integration_failure",
          title: "Appointment reschedule requires reconciliation",
          message: providerApplied
            ? "The calendar provider accepted the new appointment time, but CallBackIQ could not finish all local reschedule writes."
            : "CallBackIQ could not conclusively determine the calendar provider outcome. The replacement slot remains held to prevent a conflicting booking.",
          priority: "high",
          reason: error.message,
          recommendedAction:
            "Retry the exact same reschedule operation before making another calendar change.",
          metadata: {
            provider: originalProviderName,
            providerApplied,
            providerHandoffStaged: Boolean(stagedExternalAppointmentId),
            originalAppointmentId: String(original._id),
            replacementAppointmentId: String(replacement._id),
            idempotencyKey: key,
          },
          dedupeKey: `reschedule_reconciliation:${original._id}:${key}`,
        });
      } catch {
        // The original error remains authoritative.
      }

      error.statusCode = error.statusCode || 503;
      error.code = providerApplied
        ? "RESCHEDULE_RECONCILIATION_REQUIRED"
        : "RESCHEDULE_PROVIDER_OUTCOME_UNCERTAIN";
      error.safeCustomerMessage =
        "I couldn't safely finalize that calendar change. The requested replacement time is being protected while CallBackIQ reconciles the provider outcome.";

      try {
        await InterventionService.integrationFailure({
          businessId: business._id,
          leadId: replacement.lead,
          conversationId: replacement.conversation,
          appointmentId: replacement._id,
          provider: originalProviderName,
          error,
        });
      } catch {
        // Never mask the reschedule failure with an alerting failure.
      }

      throw error;
    }

    await tryRepairAppointmentLifecycle(replacement, business);
    await runNonBlockingAppointmentSideEffect({
      appointment: original,
      businessId: business._id,
      label: "reschedule reminder cleanup",
      task: () =>
        cancelAppointmentNotifications({
          businessId: business._id,
          appointmentId: original._id,
          reason: "Appointment rescheduled.",
        }),
    });

    await runNonBlockingAppointmentSideEffect({
      appointment: replacement,
      businessId: business._id,
      label: "rescheduled appointment reminder scheduling",
      task: () => scheduleAppointmentReminders({ appointment: replacement }),
    });

    if (replacement.lead) {
      await runNonBlockingAppointmentSideEffect({
        appointment: replacement,
        businessId: business._id,
        label: "rescheduled lead linkage",
        task: () =>
          Lead.updateOne(
            { _id: replacement.lead, business: business._id },
            {
              $set: {
                appointment: replacement._id,
                bookedAt: replacement.confirmedAt,
              },
            },
          ),
      });
    }

    SocketService.emitToBusiness(
      business._id,
      "appointment:rescheduled",
      { original, replacement },
    );
    SocketService.emitDashboardRefresh(
      business._id,
      "appointment_rescheduled",
    );
    return replacement;
  }

  static async update({ businessId, appointmentId, changes }) {
    if (changes.address !== undefined) normalizeAddress(changes.address);
    const appointment = await getAppointmentForBusiness(
      businessId,
      appointmentId,
    );
    if (Object.prototype.hasOwnProperty.call(changes, "estimatedValue") && changes.estimatedValue !== null && moneyAmount(changes.estimatedValue) === null) {
      const error = new Error("Estimated value must be null or a non-negative number."); error.statusCode = 400; throw error;
    }
    if (changes.valuationAction && changes.valuationAction !== "automatic") {
      const error = new Error("Invalid valuation action."); error.statusCode = 400; throw error;
    }
    if (changes.valuationAction === "automatic") {
      const services = await ServiceOffering.find({ business: businessId, active: true, _id: appointment.serviceOffering?._id || appointment.serviceOffering }).lean();
      Object.assign(appointment, resolveOpportunityValue({ businessId, services, selectedServiceId: appointment.serviceOffering?._id || appointment.serviceOffering }));
      appointment.valuationVersion = (appointment.valuationVersion || 0) + 1;
    } else if (Object.prototype.hasOwnProperty.call(changes, "estimatedValue")) {
      Object.assign(appointment, ownerEstimate(changes.estimatedValue));
      appointment.valuationVersion = (appointment.valuationVersion || 0) + 1;
    }
    const allowed = [
      "customerName",
      "customerPhone",
      "customerEmail",
      "address",
      "notes",
      "actualRevenue",
    ];

    for (const field of allowed) {
      if (Object.prototype.hasOwnProperty.call(changes, field)) {
        appointment[field] =
          field === "address"
            ? normalizeAddress(changes[field])
            : changes[field];
      }
    }

    if (changes.status && changes.status !== appointment.status) {
      assertTransition(appointment.status, changes.status);
      if (!["completed", "no_show"].includes(changes.status)) {
        const error = new Error(
          "Use the dedicated confirm, cancel, or reschedule endpoint.",
        );
        error.statusCode = 400;
        throw error;
      }
      appointment.status = changes.status;
      appointment.activeSlotKey = null;
      appointment.slotClaimKeys = [];
      appointment.capacityLane = null;
      if (changes.status === "completed") appointment.completedAt = new Date();
      if (changes.status === "no_show") appointment.noShowAt = new Date();
    }

    await appointment.save();

    if (appointment.status === "completed") {
      await ConversionEventService.record({
        businessId,
        leadId: appointment.lead,
        conversationId: appointment.conversation,
        appointmentId: appointment._id,
        type: "job_completed",
        channel: appointment.source,
        estimatedValue: appointment.estimatedValue,
        actualRevenue: appointment.actualRevenue,
        marketingSourceId: appointment.marketingSource || null,
        trackingNumberId: appointment.trackingNumber || null,
        attribution: appointment.attribution || {},
        idempotencyKey: `job_completed:${appointment._id}`,
      });
      if (appointment.lead) {
        await Lead.updateOne(
          { _id: appointment.lead, business: businessId },
          {
            $set: {
              completedAt: appointment.completedAt,
              actualRevenue: appointment.actualRevenue,
            },
          },
        );
      }
      await runNonBlockingAppointmentSideEffect({
        appointment,
        businessId,
        label: "post-appointment follow-up scheduling",
        task: () => schedulePostAppointmentFollowUp({ appointment }),
      });
    }


    // CALLBACKIQ_AUTHORITATIVE_OWNER_OUTCOME_V1
    SocketService.emitToBusiness(
      businessId,
      "appointment:updated",
      appointment,
    );
    SocketService.emitDashboardRefresh(
      businessId,
      appointment.status === "completed"
        ? "appointment_completed"
        : appointment.status === "no_show"
          ? "appointment_no_show"
          : "appointment_updated",
    );

    return appointment;
  }

  static list({ businessId, query = {} }) {
    const filter = { business: businessId };
    if (query.status) filter.status = query.status;
    if (query.leadId) filter.lead = query.leadId;
    if (query.conversationId) filter.conversation = query.conversationId;
    if (query.startDate || query.endDate) {
      filter.startAt = {};
      if (query.startDate) filter.startAt.$gte = new Date(query.startDate);
      if (query.endDate) filter.startAt.$lte = new Date(query.endDate);
    }
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const skip = Math.max(Number(query.skip) || 0, 0);

    return populateAppointment(
      Appointment.find(filter).sort({ startAt: 1 }).skip(skip).limit(limit),
    );
  }

  static get({ businessId, appointmentId }) {
    return populateAppointment(
      Appointment.findOne({ _id: appointmentId, business: businessId }),
    );
  }
}

export { ACTIVE_STATUSES, VALID_TRANSITIONS };
export default AppointmentService;
