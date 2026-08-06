import crypto from "crypto";

import Appointment from "../../models/appointment.js";
import Lead from "../../models/lead.js";
import ServiceOffering from "../../models/serviceOffering.js";
import AlertService from "../alert.service.js";
import AutomationTriggerService from "../automation/automationTrigger.service.js";
import ConversionEventService from "../conversionEvent.service.js";
import InterventionService from "../intervention.service.js";
import SocketService from "../socket.service.js";
import AvailabilityService from "./availability.service.js";
import {
  getBookableService,
  getSlotCapacity,
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
  held: new Set(["confirmed", "failed"]),
  confirmed: new Set(["canceled", "completed", "no_show", "rescheduled"]),
  canceled: new Set(),
  completed: new Set(),
  no_show: new Set(),
  failed: new Set(),
  rescheduled: new Set(),
};

const normalizeAddress = (address = {}) => ({
  street: String(address?.street || "").trim(),
  city: String(address?.city || "").trim(),
  state: String(address?.state || "").trim(),
  postalCode: String(address?.postalCode || "").trim(),
});

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
    console.error(`Appointment ${label} side effect failed:`, {
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
}) => {
  const timeZone = business.timezone || "America/New_York";
  const dateKey = formatDateKey(startAt, timeZone);
  const result = await AvailabilityService.getAvailability({
    business,
    serviceOfferingId,
    startDate: dateKey,
    endDate: dateKey,
    postalCode,
    excludeAppointmentId,
    providerNameOverride,
  });

  return result.slots.some(
    (slot) =>
      new Date(slot.startAt).getTime() === new Date(startAt).getTime() &&
      new Date(slot.endAt).getTime() === new Date(endAt).getTime(),
  );
};

const createHold = async ({
  business,
  service,
  input,
  idempotencyKey,
  excludeAppointmentId = null,
  checkExternalAvailability = true,
}) => {
  const businessId = business._id;
  const startAt = new Date(input.startAt);
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

  const timeZone = input.timezone || business.timezone || "America/New_York";
  const capacity = await getSlotCapacity({
    businessId,
    startAt,
    timeZone,
  });
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
    provider: businessCalendarProviderName(business),
    estimatedValue:
      input.estimatedValue ?? service.estimatedValue ?? business.estimatedJobValue ?? 0,
    actualRevenue: input.actualRevenue || 0,
    idempotencyKey,
    heldExpiresAt: addMinutes(new Date(), Number(input.holdMinutes || 5)),
    notes: input.notes || "",
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
    .populate("lead", "customerName phone serviceNeeded urgency status source recovered")
    .populate("conversation", "customerPhone customerName status humanTakeover")
    .populate("rescheduledFrom", "startAt endAt status")
    .populate("rescheduledTo", "startAt endAt status");

class AppointmentService {
  static async releaseExpiredHolds(businessId = null) {
    const query = {
      status: "held",
      heldExpiresAt: { $lte: new Date() },
      ...(businessId ? { business: businessId } : {}),
    };

    return Appointment.updateMany(query, {
      $set: {
        status: "failed",
        activeSlotKey: null,
        slotClaimKeys: [],
        capacityLane: null,
        failureReason: "Appointment hold expired before confirmation.",
      },
    });
  }

  static async create({ business, input, idempotencyKey, confirm = true }) {
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
    if (existing) return existing;

    const service = await getBookableService({
      businessId: business._id,
      serviceOfferingId: input.serviceOfferingId || input.serviceOffering,
    });
    const hold = await createHold({
      business,
      service,
      input,
      idempotencyKey: key,
      // Immediate Google confirmations perform one external availability check
      // at confirm time. The internal claim index still protects the hold.
      checkExternalAvailability:
        !confirm || businessCalendarProviderName(business) !== "google_calendar",
    });

    if (!confirm || hold.status !== "held") {
      return hold;
    }

    return this.confirm({ business, appointmentId: hold._id });
  }

  static async confirm({ business, appointmentId }) {
    const appointment = await getAppointmentForBusiness(
      business._id,
      appointmentId,
    );

    if (appointment.status === "confirmed") return appointment;
    assertTransition(appointment.status, "confirmed");

    if (appointment.heldExpiresAt && appointment.heldExpiresAt <= new Date()) {
      appointment.status = "failed";
      appointment.activeSlotKey = null;
      appointment.slotClaimKeys = [];
      appointment.capacityLane = null;
      appointment.failureReason = "The appointment hold expired before confirmation.";
      await appointment.save();
      const error = new Error("The appointment hold expired.");
      error.statusCode = 409;
      error.code = "HOLD_EXPIRED";
      throw error;
    }

    const stillAvailable = await exactSlotAvailable({
      business,
      serviceOfferingId: appointment.serviceOffering,
      startAt: appointment.startAt,
      endAt: appointment.endAt,
      postalCode: appointment.address?.postalCode,
      excludeAppointmentId: appointment._id,
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
      appointment.confirmedAt = new Date();
      appointment.heldExpiresAt = null;
      appointment.failureReason = "";
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

    // Confirmation is durable at this point. Secondary notifications and
    // analytics must never roll the appointment back if they fail.
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
      console.error("Appointment confirmation side effect failed:", {
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

  static async cancel({ business, appointmentId, reason = "" }) {
    const appointment = await getAppointmentForBusiness(
      business._id,
      appointmentId,
    );
    if (appointment.status === "canceled") return appointment;
    assertTransition(appointment.status, "canceled");
    const provider = SchedulingProviderFactory.getProvider(
      business,
      appointment.provider || "internal",
    );

    try {
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

    appointment.status = "canceled";
    appointment.canceledAt = new Date();
    appointment.activeSlotKey = null;
    appointment.slotClaimKeys = [];
    appointment.capacityLane = null;
    appointment.notes = [
      appointment.notes,
      reason ? `Cancellation: ${reason}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    await appointment.save();
    await runNonBlockingAppointmentSideEffect({
      appointment,
      businessId: business._id,
      label: "cancellation reminder cleanup",
      task: () =>
        cancelAppointmentNotifications({
          businessId: business._id,
          appointmentId: appointment._id,
          reason: "Appointment canceled.",
        }),
    });
    await ConversionEventService.record({
      businessId: business._id,
      leadId: appointment.lead,
      conversationId: appointment.conversation,
      appointmentId: appointment._id,
      type: "appointment_canceled",
      channel: appointment.source,
      estimatedValue: appointment.estimatedValue,
      idempotencyKey: `appointment_canceled:${appointment._id}`,
      metadata: { reason },
    });
    await InterventionService.create({
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
    });
    if (appointment.conversation) {
      await AutomationTriggerService.schedule({
        businessId: business._id,
        trigger: "canceled_appointment_recovery",
        leadId: appointment.lead,
        conversationId: appointment.conversation,
        appointmentId: appointment._id,
        triggerInstanceId: String(appointment._id),
        occurredAt: appointment.canceledAt,
      });
    }
    SocketService.emitToBusiness(
      business._id,
      "appointment:canceled",
      appointment,
    );
    return appointment;
  }

  static async reschedule({ business, appointmentId, input, idempotencyKey }) {
    const original = await getAppointmentForBusiness(
      business._id,
      appointmentId,
    );
    assertTransition(original.status, "rescheduled");
    const service = await getBookableService({
      businessId: business._id,
      serviceOfferingId: original.serviceOffering,
    });
    const key = String(
      idempotencyKey ||
        input.idempotencyKey ||
        `reschedule:${original._id}:${crypto.randomUUID()}`,
    );
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
      const error = new Error("The requested replacement time is unavailable.");
      error.statusCode = 409;
      error.code = "SLOT_UNAVAILABLE";
      throw error;
    }

    const replacement = await createHold({
      business,
      service,
      input: nextInput,
      idempotencyKey: key,
      excludeAppointmentId: original._id,
    });
    replacement.rescheduledFrom = original._id;
    await replacement.save();
    const provider = SchedulingProviderFactory.getProvider(
      business,
      original.provider || "internal",
    );

    try {
      const providerResult = await provider.updateAppointment({
        appointment: original,
        eventAppointment: replacement,
        changes: {
          startAt: replacement.startAt,
          endAt: replacement.endAt,
        },
        service,
      });
      original.status = "rescheduled";
      original.rescheduledTo = replacement._id;
      original.activeSlotKey = null;
      original.slotClaimKeys = [];
      original.capacityLane = null;
      original.externalAppointmentId = null;
      original.externalCalendarId = null;
      await original.save();

      replacement.status = "confirmed";
      replacement.confirmedAt = new Date();
      replacement.heldExpiresAt = null;
      replacement.provider =
        providerResult.provider || original.provider || "internal";
      replacement.externalAppointmentId =
        providerResult.externalAppointmentId || null;
      replacement.externalCalendarId =
        providerResult.externalCalendarId || null;
      await replacement.save();
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
        await Lead.updateOne(
          { _id: replacement.lead, business: business._id },
          {
            $set: {
              appointment: replacement._id,
              bookedAt: replacement.confirmedAt,
            },
          },
        );
      }
      SocketService.emitToBusiness(
        business._id,
        "appointment:rescheduled",
        { original, replacement },
      );
      return replacement;
    } catch (error) {
      replacement.status = "failed";
      replacement.activeSlotKey = null;
      replacement.slotClaimKeys = [];
      replacement.capacityLane = null;
      replacement.failureReason = error.message;
      await replacement.save();
      await InterventionService.integrationFailure({
        businessId: business._id,
        leadId: replacement.lead,
        conversationId: replacement.conversation,
        appointmentId: replacement._id,
        provider: original.provider || "internal",
        error,
      });
      throw error;
    }
  }

  static async update({ businessId, appointmentId, changes }) {
    const appointment = await getAppointmentForBusiness(
      businessId,
      appointmentId,
    );
    const allowed = [
      "customerName",
      "customerPhone",
      "customerEmail",
      "address",
      "notes",
      "estimatedValue",
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
