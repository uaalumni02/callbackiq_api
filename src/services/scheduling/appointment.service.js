import { applyAppointmentBookingTransition } from "../booking/appointmentBookingTransition.repository.js";
import { createAppointmentrecheckAndConfirm1Methods } from './commands/recheckAndConfirm-1.js';
import { createAppointmentcreate1Methods } from './commands/create-1.js';
import { createAppointmentconfirm1Methods } from './commands/confirm-1.js';
import { confirmWithoutRecovery } from './commands/confirmWithoutRecovery.js';
import { assertConfirmationNotPending, confirmationPending, createConfirmationIntentRepository } from './appointmentConfirmationIntent.repository.js';
import { createConfirmationRecovery } from './appointmentConfirmationRecovery.service.js';
import { createAppointmentcancel1Methods } from './commands/cancel-1.js';
import { createAppointmentreschedule1Methods } from './commands/reschedule-1.js';
import { createAppointmentupdate1Methods } from './commands/update-1.js';
import { createExpiredHoldReconciler } from './appointmentHoldExpiry.service.js';
import { resolveAppointmentAttribution } from './appointmentAttribution.repository.js';
import { createAppointmentLookup } from './appointmentLookup.adapter.js';
import { createExactSlotAvailability } from './appointmentAvailability.adapter.js';
import {ACTIVE_STATUSES,VALID_TRANSITIONS,getSlotKey,getSlotClaimKeys,assertTransition} from './appointmentStatePolicy.service.js';
import {createNonBlockingAppointmentSideEffect} from './appointmentEffectAdapter.service.js';
import { reconcileAppointmentNoticeFailures } from './appointmentNoticeFailure.service.js';
import { projectionMarker, tryRepairAppointmentProjections, repairPendingAppointmentProjections } from './appointmentProjection.service.js';
import { lifecycleMarker, tryRepairAppointmentLifecycle, repairPendingAppointmentLifecycles } from './appointmentLifecycle.service.js';
import { repairRescheduleReviews } from './rescheduleRequest.service.js';
import { normalizeAppointmentAddress as normalizeAddress } from './appointmentAddress.service.js';
import { ensureBusinessApprovalNotice, repairConfirmedApproval } from './appointmentConfirmation.service.js';
import { runApprovalSms } from './approvalSms.service.js';
import { arrivalWindow, customerAppointmentLabel } from './customerAppointmentPresentation.service.js';
import { reconcileApprovalRequests, resolveApprovalReview } from './approvalLifecycle.service.js';
import { preservePendingApprovalOnAvailabilityConflict } from './approvalAvailabilityFailurePolicy.js';
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
} from "./appointmentNotification.service.js";
import { addMinutes, formatDateKey } from "./timezone.service.js";

export { ensureBusinessApprovalNotice } from './appointmentConfirmation.service.js';

const getAppointmentForBusiness = createAppointmentLookup({ Appointment });

const runNonBlockingAppointmentSideEffect = createNonBlockingAppointmentSideEffect({safeConsole, InterventionService});

const exactSlotAvailable = createExactSlotAvailability({ AvailabilityService, withStaffSchedulingException, formatDateKey });

const confirmationIntent = createConfirmationIntentRepository({ Appointment });
const confirmationRecovery = createConfirmationRecovery({
  intent: confirmationIntent, ServiceOffering, SchedulingProviderFactory, InterventionService, safeConsole,
  exactSlotAvailable, assertServiceRequestEligible, assertDistributedLeaseActive, projectionMarker, lifecycleMarker,
});

const releaseExpiredHolds = createExpiredHoldReconciler({
  Appointment,
  reconcileApprovalRequests,
  repairPendingAppointmentLifecycles,
  repairPendingAppointmentProjections,
  repairRescheduleReviews,
  reconcileAppointmentNoticeFailures,
  runApprovalSms
});

export { resolveAppointmentAttribution };

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


let __meekcallAppointmentrecheckAndConfirm1Cache;
function __meekcallGetAppointmentrecheckAndConfirm1Methods() {
  if (!__meekcallAppointmentrecheckAndConfirm1Cache) __meekcallAppointmentrecheckAndConfirm1Cache = createAppointmentrecheckAndConfirm1Methods({ assertConfirmationNotPending, Appointment, addMinutes, assertDistributedLeaseActive, exactSlotAvailable, getAppointmentForBusiness, getSlotCapacity, getSlotClaimKeys, getSlotKey, repairConfirmedApproval, tryRepairAppointmentProjections, withDistributedLease });
  return __meekcallAppointmentrecheckAndConfirm1Cache;
}

let __meekcallAppointmentcreate1Cache;
function __meekcallGetAppointmentcreate1Methods() {
  if (!__meekcallAppointmentcreate1Cache) __meekcallAppointmentcreate1Cache = createAppointmentcreate1Methods({ Appointment, SocketService, assertServiceRequestEligible, businessCalendarProviderName, createHold, crypto, getAiBookableService, getBookableService, moneyAmount, normalizeAddress, tryRepairAppointmentLifecycle, tryRepairAppointmentProjections });
  return __meekcallAppointmentcreate1Cache;
}

let __meekcallAppointmentconfirm1Cache;
function __meekcallGetAppointmentconfirm1Methods() {
  if (!__meekcallAppointmentconfirm1Cache) __meekcallAppointmentconfirm1Cache = createAppointmentconfirm1Methods({ assertConfirmationNotPending, confirmationPending, confirmWithoutRecovery, applyAppointmentBookingTransition, Conversation, InterventionService, SchedulingProviderFactory, ServiceOffering, SocketService, assertDistributedLeaseActive, assertServiceRequestEligible, assertTransition, ensureBusinessApprovalNotice, exactSlotAvailable, getAppointmentForBusiness, lifecycleMarker, preservePendingApprovalOnAvailabilityConflict, projectionMarker, resolveApprovalReview, runNonBlockingAppointmentSideEffect, scheduleAppointmentReminders, tryRepairAppointmentLifecycle, tryRepairAppointmentProjections, safeConsole, businessCalendarProviderName, intent: confirmationIntent, recovery: confirmationRecovery });
  return __meekcallAppointmentconfirm1Cache;
}

let __meekcallAppointmentcancel1Cache;
function __meekcallGetAppointmentcancel1Methods() {
  if (!__meekcallAppointmentcancel1Cache) __meekcallAppointmentcancel1Cache = createAppointmentcancel1Methods({ assertConfirmationNotPending, InterventionService, SchedulingProviderFactory, SocketService, assertTransition, cancelAppointmentNotifications, ensureCancellationSideEffects, getAppointmentForBusiness, lifecycleMarker, resolveApprovalReview, runNonBlockingAppointmentSideEffect, tryRepairAppointmentLifecycle });
  return __meekcallAppointmentcancel1Cache;
}

let __meekcallAppointmentreschedule1Cache;
function __meekcallGetAppointmentreschedule1Methods() {
  if (!__meekcallAppointmentreschedule1Cache) __meekcallAppointmentreschedule1Cache = createAppointmentreschedule1Methods({ Appointment, InterventionService, Lead, SchedulingProviderFactory, SocketService, addMinutes, assertTransition, cancelAppointmentNotifications, createHold, crypto, exactSlotAvailable, getAppointmentForBusiness, getBookableService, lifecycleMarker, normalizeAddress, runNonBlockingAppointmentSideEffect, scheduleAppointmentReminders, tryRepairAppointmentLifecycle });
  return __meekcallAppointmentreschedule1Cache;
}

let __meekcallAppointmentupdate1Cache;
function __meekcallGetAppointmentupdate1Methods() {
  if (!__meekcallAppointmentupdate1Cache) __meekcallAppointmentupdate1Cache = createAppointmentupdate1Methods({ assertConfirmationNotPending, ServiceOffering, SocketService, assertTransition, getAppointmentForBusiness, moneyAmount, normalizeAddress, ownerEstimate, projectionMarker, resolveOpportunityValue, tryRepairAppointmentProjections });
  return __meekcallAppointmentupdate1Cache;
}

class AppointmentService {
  static async releaseExpiredHolds(businessId = null) {
    return releaseExpiredHolds(businessId);
  }

  static async reconcileConfirmations(options) {
    return __meekcallGetAppointmentconfirm1Methods().reconcileConfirmations(options);
  }

  static async recheckAndConfirm(...args) { return __meekcallGetAppointmentrecheckAndConfirm1Methods().recheckAndConfirm.apply(this, args); }

  static async create(...args) { return __meekcallGetAppointmentcreate1Methods().create.apply(this, args); }

  static async confirm(...args) { return __meekcallGetAppointmentconfirm1Methods().confirm.apply(this, args); }

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

    assertConfirmationNotPending(appointment);

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

  static async cancel(...args) { return __meekcallGetAppointmentcancel1Methods().cancel.apply(this, args); }

  static async reschedule(...args) { return __meekcallGetAppointmentreschedule1Methods().reschedule.apply(this, args); }

  static async update(...args) { return __meekcallGetAppointmentupdate1Methods().update.apply(this, args); }

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
