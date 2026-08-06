import Alert from "../../models/alert.js";
import Appointment from "../../models/appointment.js";
import AvailabilityService from "../scheduling/availability.service.js";
import { getSlotCapacity } from "../scheduling/appointmentPolicy.service.js";
import {
  cancelAppointmentNotifications,
  scheduleAppointmentChangeNotice,
  scheduleAppointmentReminders,
} from "../scheduling/appointmentNotification.service.js";
import SchedulingProviderFactory from "../scheduling/schedulingProviderFactory.js";
import InterventionService from "../intervention.service.js";
import SocketService from "../socket.service.js";
import { formatDateKey } from "../scheduling/timezone.service.js";

const minuteMs = 60_000;

const providerChangeKey = (change = {}) =>
  String(
    change.eventSequence ||
      change.eventUpdated ||
      change.eventStatus ||
      `${change.type}:${change.startAt || ""}:${change.endAt || ""}`,
  );

const getSlotClaimKeys = ({
  startAt,
  endAt,
  bufferBeforeMinutes = 0,
  bufferAfterMinutes = 0,
  capacityLane,
}) => {
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

const displayTime = (date, timeZone = "America/New_York") =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));

const resolveReviewAlerts = async ({ businessId, appointmentId, resolution }) =>
  Alert.updateMany(
    {
      business: businessId,
      appointment: appointmentId,
      type: "appointment_change_review",
      resolvedAt: null,
    },
    {
      $set: {
        status: "resolved",
        resolvedAt: new Date(),
        resolution,
      },
    },
  );

export const queueGoogleProviderChange = async ({
  appointment,
  calendarId,
  event,
  type,
  startAt = null,
  endAt = null,
}) => {
  const changeKey = providerChangeKey({
    type,
    startAt,
    endAt,
    eventSequence: event.sequence,
    eventUpdated: event.updated,
    eventStatus: event.status,
  });
  const current = appointment.pendingProviderChange;
  if (
    current?.type === type &&
    String(current.eventSequence || "") === changeKey
  ) {
    // Incremental/full sync can replay the same Google event. A previously
    // reviewed sequence must never reopen the customer-impacting decision.
    return appointment;
  }

  appointment.externalAppointmentId = event.id || appointment.externalAppointmentId;
  appointment.externalCalendarId = calendarId || appointment.externalCalendarId;
  appointment.provider = "google_calendar";
  appointment.pendingProviderChange = {
    type,
    status: "pending_review",
    startAt: type === "move" ? new Date(startAt) : null,
    endAt: type === "move" ? new Date(endAt) : null,
    calendarId: calendarId || "",
    eventId: event.id || "",
    eventSequence: changeKey,
    detectedAt: new Date(),
    reviewedAt: null,
    reviewedBy: null,
  };
  await appointment.save();

  const moveMessage =
    type === "move"
      ? `Google Calendar proposes moving this appointment from ${displayTime(
          appointment.startAt,
          appointment.timezone,
        )} to ${displayTime(startAt, appointment.timezone)}.`
      : "This appointment was deleted or canceled directly in Google Calendar.";

  await InterventionService.create({
    businessId: appointment.business,
    leadId: appointment.lead,
    conversationId: appointment.conversation,
    appointmentId: appointment._id,
    type: "appointment_change_review",
    title:
      type === "move"
        ? "Approve Google Calendar appointment move"
        : "Approve Google Calendar cancellation",
    message: `${moveMessage} The customer has not been notified yet.`,
    priority: "high",
    reason:
      "Calendar changes require owner approval so tentative planning does not silently change a customer commitment.",
    recommendedAction:
      type === "move"
        ? "Approve the proposed time after reviewing coverage, or reject it to restore the original Google event."
        : "Approve the cancellation to notify the customer, or reject it to recreate the calendar event.",
    metadata: {
      provider: "google_calendar",
      changeType: type,
      currentStartAt: appointment.startAt,
      currentEndAt: appointment.endAt,
      proposedStartAt: startAt,
      proposedEndAt: endAt,
      googleCalendarId: calendarId || "",
      googleEventId: event.id || "",
      googleEventSequence: changeKey,
    },
    dedupeKey: `google_calendar_change_review:${appointment._id}:${changeKey}`,
  });

  SocketService.emitToBusiness(
    appointment.business,
    "appointment:provider-change-pending",
    appointment,
  );
  return appointment;
};

const assertPendingChange = async ({ businessId, appointmentId }) => {
  const appointment = await Appointment.findOne({
    _id: appointmentId,
    business: businessId,
  }).populate("serviceOffering");
  if (!appointment) {
    const error = new Error("Appointment not found.");
    error.statusCode = 404;
    throw error;
  }
  if (appointment.pendingProviderChange?.status !== "pending_review") {
    const error = new Error("This appointment has no Google Calendar change awaiting review.");
    error.statusCode = 409;
    error.code = "NO_PENDING_PROVIDER_CHANGE";
    throw error;
  }
  return appointment;
};

const approveMove = async ({ business, appointment, reviewedBy }) => {
  const change = appointment.pendingProviderChange;
  const startAt = new Date(change.startAt);
  const endAt = new Date(change.endAt);
  const timeZone = appointment.timezone || business.timezone || "America/New_York";
  const dateKey = formatDateKey(startAt, timeZone);
  const availability = await AvailabilityService.getAvailability({
    business,
    serviceOfferingId: appointment.serviceOffering?._id || appointment.serviceOffering,
    startDate: dateKey,
    endDate: dateKey,
    postalCode: appointment.address?.postalCode,
    excludeAppointmentId: appointment._id,
    excludeExternalEventId: change.eventId,
    providerNameOverride: "google_calendar",
  });
  const exactAvailable = availability.slots.some(
    (slot) =>
      new Date(slot.startAt).getTime() === startAt.getTime() &&
      new Date(slot.endAt).getTime() === endAt.getTime(),
  );
  if (!exactAvailable) {
    const error = new Error(
      availability.serviceArea?.supported === false
        ? "The proposed Google Calendar time is outside the configured service area."
        : "The proposed Google Calendar time conflicts with business hours, notice rules, or existing capacity.",
    );
    error.statusCode = 409;
    error.code = "PROVIDER_CHANGE_UNAVAILABLE";
    throw error;
  }

  const capacity = await getSlotCapacity({
    businessId: business._id,
    startAt,
    timeZone,
  });
  let updated = null;
  for (let capacityLane = 1; capacityLane <= capacity; capacityLane += 1) {
    try {
      updated = await Appointment.findOneAndUpdate(
        {
          _id: appointment._id,
          business: business._id,
          "pendingProviderChange.status": "pending_review",
        },
        {
          $set: {
            startAt,
            endAt,
            capacityLane,
            activeSlotKey: `${startAt.toISOString()}|${endAt.toISOString()}|lane:${capacityLane}`,
            slotClaimKeys: getSlotClaimKeys({
              startAt,
              endAt,
              bufferBeforeMinutes: appointment.bufferBeforeMinutes,
              bufferAfterMinutes: appointment.bufferAfterMinutes,
              capacityLane,
            }),
            externalAppointmentId: change.eventId,
            externalCalendarId: change.calendarId,
            provider: "google_calendar",
            "pendingProviderChange.status": "approved",
            "pendingProviderChange.reviewedAt": new Date(),
            "pendingProviderChange.reviewedBy": reviewedBy || null,
          },
        },
        { new: true, runValidators: true },
      ).populate("serviceOffering");
      if (updated) break;
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  if (!updated) {
    const error = new Error("The proposed time was claimed by another appointment.");
    error.statusCode = 409;
    error.code = "SLOT_UNAVAILABLE";
    throw error;
  }

  await cancelAppointmentNotifications({
    businessId: business._id,
    appointmentId: updated._id,
    reason: "Appointment moved in Google Calendar.",
  });
  await scheduleAppointmentReminders({ appointment: updated });
  await scheduleAppointmentChangeNotice({
    appointment: updated,
    key: `google_move:${change.eventSequence}`,
    body: `${business.businessName || "The service team"}: Your appointment has been moved to ${displayTime(
      updated.startAt,
      updated.timezone,
    )}. Reply C to confirm or R to request another time.`,
  });
  return updated;
};

const approveCancel = async ({ business, appointment, reviewedBy }) => {
  const change = appointment.pendingProviderChange;
  appointment.status = "canceled";
  appointment.canceledAt = new Date();
  appointment.activeSlotKey = null;
  appointment.slotClaimKeys = [];
  appointment.capacityLane = null;
  appointment.pendingProviderChange.status = "approved";
  appointment.pendingProviderChange.reviewedAt = new Date();
  appointment.pendingProviderChange.reviewedBy = reviewedBy || null;
  await appointment.save();
  await cancelAppointmentNotifications({
    businessId: business._id,
    appointmentId: appointment._id,
    reason: "Appointment canceled from Google Calendar.",
  });
  await scheduleAppointmentChangeNotice({
    appointment,
    key: `google_cancel:${change.eventSequence}`,
    body: `${business.businessName || "The service team"}: Your appointment on ${displayTime(
      appointment.startAt,
      appointment.timezone,
    )} was canceled. Reply R if you would like another time.`,
  });
  return appointment;
};

export const approveGoogleProviderChange = async ({
  business,
  appointmentId,
  reviewedBy = null,
}) => {
  const appointment = await assertPendingChange({
    businessId: business._id,
    appointmentId,
  });
  const type = appointment.pendingProviderChange.type;
  const updated =
    type === "move"
      ? await approveMove({ business, appointment, reviewedBy })
      : await approveCancel({ business, appointment, reviewedBy });
  await resolveReviewAlerts({
    businessId: business._id,
    appointmentId,
    resolution: `Google Calendar ${type} approved by the business.`,
  });
  SocketService.emitToBusiness(
    business._id,
    "appointment:provider-change-approved",
    updated,
  );
  return updated;
};

export const rejectGoogleProviderChange = async ({
  business,
  appointmentId,
  reviewedBy = null,
}) => {
  const appointment = await assertPendingChange({
    businessId: business._id,
    appointmentId,
  });
  const change = appointment.pendingProviderChange;
  const provider = SchedulingProviderFactory.getProvider(
    business,
    "google_calendar",
  );
  let providerResult = null;
  if (change.type === "move") {
    providerResult = await provider.updateAppointment({
      appointment,
      changes: { startAt: appointment.startAt, endAt: appointment.endAt },
      service: appointment.serviceOffering,
    });
  } else if (typeof provider.restoreAppointment === "function") {
    providerResult = await provider.restoreAppointment({
      appointment,
      service: appointment.serviceOffering,
      changeKey: change.eventSequence,
    });
  } else {
    const error = new Error("The connected calendar provider cannot restore canceled events.");
    error.statusCode = 409;
    error.code = "PROVIDER_CHANGE_RESTORE_UNSUPPORTED";
    throw error;
  }

  appointment.externalAppointmentId =
    providerResult?.externalAppointmentId || appointment.externalAppointmentId;
  appointment.externalCalendarId =
    providerResult?.externalCalendarId || appointment.externalCalendarId;
  appointment.pendingProviderChange.status = "rejected";
  appointment.pendingProviderChange.reviewedAt = new Date();
  appointment.pendingProviderChange.reviewedBy = reviewedBy || null;
  await appointment.save();
  await resolveReviewAlerts({
    businessId: business._id,
    appointmentId,
    resolution: `Google Calendar ${change.type} rejected; the original customer commitment was restored.`,
  });
  SocketService.emitToBusiness(
    business._id,
    "appointment:provider-change-rejected",
    appointment,
  );
  return appointment;
};
