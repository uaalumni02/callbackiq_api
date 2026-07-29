import crypto from "crypto";

import SchedulingProvider from "./schedulingProvider.js";
import { generateInternalSlots } from "../../services/scheduling/slotGenerator.service.js";
import {
  getGoogleConnection,
  googleApiRequest,
  listGoogleCalendars,
} from "../../services/integrations/googleCalendarConnection.service.js";
import { getGoogleSettings } from "../../services/integrations/integrationSettings.service.js";

const encode = encodeURIComponent;

const overlaps = (slot, busy) =>
  new Date(slot.startAt) < new Date(busy.end) &&
  new Date(slot.endAt) > new Date(busy.start);

export const deterministicEventId = (appointment) =>
  crypto
    .createHash("sha256")
    .update(
      `${appointment?.business || appointment?.businessId || ""}:${appointment?._id || appointment?.id || ""}`,
    )
    .digest("hex")
    .slice(0, 32);

const connectionError = (connection) => {
  const error = new Error("Google Calendar is not connected.");
  error.statusCode = 409;
  error.code = ["reconnect_required", "expired"].includes(connection?.status)
    ? "GOOGLE_RECONNECT_REQUIRED"
    : "GOOGLE_NOT_CONNECTED";
  return error;
};

const normalizeSettings = async (businessId) => {
  const connection = await getGoogleConnection(businessId);

  // Older connection fixtures omitted status. Treat only an explicit non-connected
  // state as disconnected so existing providers and tests remain compatible.
  if (!connection || (connection.status && connection.status !== "connected")) {
    throw connectionError(connection);
  }

  const settings = getGoogleSettings(connection) || {};
  const bookingCalendarId = String(
    settings.bookingCalendarId || connection.providerCalendarId || "",
  ).trim();

  if (!bookingCalendarId) {
    const error = new Error(
      "Select a writable Google Calendar before booking.",
    );
    error.statusCode = 409;
    error.code = "GOOGLE_CALENDAR_NOT_SELECTED";
    throw error;
  }

  const configuredAvailabilityIds =
    settings.availabilityCalendarIds?.length
      ? settings.availabilityCalendarIds
      : connection.availabilityCalendarIds?.length
        ? connection.availabilityCalendarIds
        : [bookingCalendarId];
  const availabilityCalendarIds = [
    ...new Set(
      configuredAvailabilityIds
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  ];

  if (!availabilityCalendarIds.includes(bookingCalendarId)) {
    availabilityCalendarIds.push(bookingCalendarId);
  }

  return {
    connection,
    settings,
    bookingCalendarId,
    availabilityCalendarIds,
  };
};

const addressText = (appointment) =>
  [
    appointment.address?.street,
    appointment.address?.city,
    appointment.address?.state,
    appointment.address?.postalCode,
  ]
    .filter(Boolean)
    .join(", ");

export const buildGoogleEvent = ({ appointment, service, business }) => ({
  id: deterministicEventId(appointment),
  summary: `${service?.name || "Service appointment"} — ${appointment.customerName || "Customer"}`,
  location: addressText(appointment),
  description: [
    `CallBackIQ appointment: ${appointment._id}`,
    `Customer: ${appointment.customerName || "Customer"}`,
    `Phone: ${appointment.customerPhone || ""}`,
    appointment.customerEmail ? `Email: ${appointment.customerEmail}` : "",
    `Service: ${service?.name || "Service requested"}`,
    `Address: ${addressText(appointment)}`,
    `Estimated value: ${Number(appointment.estimatedValue || 0)}`,
    appointment.notes ? `Notes: ${appointment.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n"),
  start: {
    dateTime: new Date(appointment.startAt).toISOString(),
    timeZone: appointment.timezone || business.timezone || "America/New_York",
  },
  end: {
    dateTime: new Date(appointment.endAt).toISOString(),
    timeZone: appointment.timezone || business.timezone || "America/New_York",
  },
  visibility: "private",
  transparency: "opaque",
  extendedProperties: {
    private: {
      callbackiqAppointmentId: String(appointment._id),
      callbackiqBusinessId: String(
        appointment.business || business._id || business.id || "",
      ),
      callbackiqLeadId: appointment.lead ? String(appointment.lead) : "",
      callbackiqConversationId: appointment.conversation
        ? String(appointment.conversation)
        : "",
    },
  },
});

class GoogleCalendarProvider extends SchedulingProvider {
  async getAvailability(options) {
    const businessId = this.business._id || this.business.id;
    const slots = await generateInternalSlots({
      ...options,
      business: this.business,
    });

    // Internal rules are authoritative. When they yield no slots there is no
    // reason to require or call an external provider.
    if (Array.isArray(slots) && slots.length === 0) return [];

    const { availabilityCalendarIds } = await normalizeSettings(businessId);
    if (!Array.isArray(slots) || slots.length === 0) return [];

    const timeMin = new Date(
      Math.min(...slots.map((slot) => new Date(slot.startAt).getTime())),
    ).toISOString();
    const timeMax = new Date(
      Math.max(...slots.map((slot) => new Date(slot.endAt).getTime())),
    ).toISOString();
    const response = await googleApiRequest({
      businessId,
      path: "/freeBusy",
      method: "POST",
      body: {
        timeMin,
        timeMax,
        timeZone: this.business.timezone || "America/New_York",
        items: availabilityCalendarIds.map((id) => ({ id })),
      },
    });

    const calendarResults = response?.calendars || {};
    const failedCalendar = Object.entries(calendarResults).find(
      ([, result]) => Array.isArray(result?.errors) && result.errors.length,
    );
    if (failedCalendar) {
      const error = new Error(
        `Google could not read availability from calendar ${failedCalendar[0]}.`,
      );
      error.statusCode = 409;
      error.code = "GOOGLE_AVAILABILITY_CALENDAR_ERROR";
      throw error;
    }

    const busyRanges = Object.values(calendarResults).flatMap(
      (calendar) => calendar?.busy || [],
    );
    return slots.filter(
      (slot) => !busyRanges.some((interval) => overlaps(slot, interval)),
    );
  }

  async createAppointment({ appointment, service }) {
    const businessId = this.business._id || this.business.id;
    const { bookingCalendarId, settings } = await normalizeSettings(businessId);
    const eventBody = buildGoogleEvent({
      appointment,
      service,
      business: this.business,
    });
    const query = new URLSearchParams({
      sendUpdates: settings.sendUpdates || "none",
    });

    let event;
    try {
      event = await googleApiRequest({
        businessId,
        path: `/calendars/${encode(bookingCalendarId)}/events?${query}`,
        method: "POST",
        body: eventBody,
      });
    } catch (error) {
      // A deterministic event ID makes an uncertain retry safe.
      if (
        error.statusCode !== 409 &&
        error.providerStatus !== 409 &&
        error.providerPayload?.error?.code !== 409
      ) {
        throw error;
      }
      event = await googleApiRequest({
        businessId,
        path: `/calendars/${encode(bookingCalendarId)}/events/${encode(eventBody.id)}`,
      });
    }

    return {
      provider: "google_calendar",
      externalAppointmentId: event?.id || eventBody.id,
      externalCalendarId: bookingCalendarId,
      raw: event,
    };
  }

  async updateAppointment({ appointment, changes, service }) {
    const eventId = appointment.externalAppointmentId;
    if (!eventId) {
      const error = new Error(
        "The Google event ID is missing from the appointment.",
      );
      error.statusCode = 409;
      error.code = "GOOGLE_EVENT_ID_MISSING";
      throw error;
    }

    const businessId = this.business._id || this.business.id;
    const { bookingCalendarId, settings } = await normalizeSettings(businessId);
    const calendarId = appointment.externalCalendarId || bookingCalendarId;
    const baseAppointment =
      typeof appointment.toObject === "function"
        ? appointment.toObject()
        : appointment;
    const baseAddress =
      typeof appointment.address?.toObject === "function"
        ? appointment.address.toObject()
        : appointment.address || {};
    const nextAppointment = {
      ...baseAppointment,
      ...changes,
      address: { ...baseAddress, ...(changes?.address || {}) },
    };
    const body = buildGoogleEvent({
      appointment: nextAppointment,
      service,
      business: this.business,
    });
    delete body.id;
    const query = new URLSearchParams({
      sendUpdates: settings.sendUpdates || "none",
    });
    const event = await googleApiRequest({
      businessId,
      path: `/calendars/${encode(calendarId)}/events/${encode(eventId)}?${query}`,
      method: "PUT",
      body,
    });

    return {
      provider: "google_calendar",
      externalAppointmentId: event?.id || eventId,
      externalCalendarId: calendarId,
      raw: event,
    };
  }

  async cancelAppointment({ appointment }) {
    if (!appointment.externalAppointmentId) {
      return { canceled: true, alreadyMissing: true };
    }

    const businessId = this.business._id || this.business.id;
    const { bookingCalendarId, settings } = await normalizeSettings(businessId);
    const calendarId = appointment.externalCalendarId || bookingCalendarId;
    const query = new URLSearchParams({
      sendUpdates: settings.sendUpdates || "none",
    });
    const result = await googleApiRequest({
      businessId,
      path: `/calendars/${encode(calendarId)}/events/${encode(appointment.externalAppointmentId)}?${query}`,
      method: "DELETE",
      allowStatuses: [404, 410],
    });

    return {
      canceled: true,
      ...(result?.__providerStatus
        ? { alreadyMissing: [404, 410].includes(result.__providerStatus) }
        : {}),
    };
  }

  async getAppointment({ appointment }) {
    if (!appointment.externalAppointmentId) {
      const error = new Error(
        "The Google event ID is missing from the appointment.",
      );
      error.statusCode = 409;
      error.code = "GOOGLE_EVENT_ID_MISSING";
      throw error;
    }

    const businessId = this.business._id || this.business.id;
    const { bookingCalendarId } = await normalizeSettings(businessId);
    const calendarId = appointment.externalCalendarId || bookingCalendarId;
    return googleApiRequest({
      businessId,
      path: `/calendars/${encode(calendarId)}/events/${encode(appointment.externalAppointmentId)}`,
    });
  }

  async testConnection() {
    const businessId = this.business._id || this.business.id;
    const { connection, bookingCalendarId } = await normalizeSettings(businessId);

    // Newer implementations expose a safe calendar-list helper. Older tests and
    // integrations mock only googleApiRequest, so fall back to the canonical
    // calendar GET when the list helper is unavailable.
    const calendars =
      typeof listGoogleCalendars === "function"
        ? await listGoogleCalendars(businessId, true)
        : undefined;
    let selected = Array.isArray(calendars)
      ? calendars.find((calendar) => calendar.id === bookingCalendarId)
      : null;

    if (!Array.isArray(calendars)) {
      selected = await googleApiRequest({
        businessId,
        path: `/calendars/${encode(bookingCalendarId)}`,
      });
    } else if (!selected?.canWrite && !selected?.writable) {
      const error = new Error(
        "The selected Google booking calendar is no longer writable.",
      );
      error.statusCode = 409;
      error.code = "GOOGLE_BOOKING_CALENDAR_NOT_WRITABLE";
      throw error;
    }

    if (typeof connection.save === "function") {
      connection.lastVerifiedAt = new Date();
      connection.providerCalendarName = selected?.summary || "";
      connection.lastErrorAt = null;
      connection.lastErrorCode = "";
      connection.lastErrorMessage = "";
      await connection.save();
    }

    return {
      connected: true,
      provider: "google_calendar",
      calendar: {
        id: selected?.id || bookingCalendarId,
        summary: selected?.summary,
        timeZone: selected?.timeZone,
      },
    };
  }
}

export default GoogleCalendarProvider;
