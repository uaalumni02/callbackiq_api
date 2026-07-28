import crypto from "crypto";

import SchedulingProvider from "./schedulingProvider.js";
import { generateInternalSlots } from "../../services/scheduling/slotGenerator.service.js";
import {
  getGoogleConnection,
  googleApiRequest,
} from "../../services/integrations/googleCalendarConnection.service.js";
import { getGoogleSettings } from "../../services/integrations/integrationSettings.service.js";

const encodeCalendarId = (value) => encodeURIComponent(value);
const overlaps = (slot, busy) =>
  new Date(slot.startAt) < new Date(busy.end) &&
  new Date(slot.endAt) > new Date(busy.start);

const deterministicEventId = (appointment, fallbackBusinessId = "") =>
  crypto
    .createHash("sha256")
    .update(
      `callbackiq:${appointment.business || fallbackBusinessId}:${appointment._id}`,
    )
    .digest("hex")
    .slice(0, 32);

const getConnectionAndSettings = async (businessId) => {
  const connection = await getGoogleConnection(businessId);
  if (
    !connection ||
    (connection.status && connection.status !== "connected")
  ) {
    const error = new Error("Google Calendar is not connected.");
    error.statusCode = 409;
    error.code = "GOOGLE_NOT_CONNECTED";
    throw error;
  }
  const settings = getGoogleSettings(connection);
  if (!settings.bookingCalendarId) {
    const error = new Error("Select a writable Google booking calendar.");
    error.statusCode = 409;
    error.code = "GOOGLE_CALENDAR_NOT_SELECTED";
    throw error;
  }
  return { connection, settings };
};

const addressText = (address = {}) =>
  [address.street, address.city, address.state, address.postalCode]
    .filter(Boolean)
    .join(", ");

const buildEvent = ({ appointment, service, business, settings }) => {
  const attendeeEmail =
    appointment.customerEmail || settings.defaultAttendeeEmail || "";
  return {
    id: deterministicEventId(
      appointment,
      business._id || business.id,
    ),
    summary: `${service?.name || "Service appointment"} — ${
      appointment.customerName || "Customer"
    }`,
    description: [
      `CallBackIQ appointment: ${appointment._id}`,
      `Customer: ${appointment.customerName || "Customer"}`,
      `Phone: ${appointment.customerPhone || ""}`,
      `Email: ${appointment.customerEmail || ""}`,
      `Service: ${service?.name || "Service requested"}`,
      `Address: ${addressText(appointment.address)}`,
      `Estimated value: ${Number(appointment.estimatedValue || 0)}`,
      appointment.notes ? `Notes: ${appointment.notes}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    location: addressText(appointment.address),
    start: {
      dateTime: new Date(appointment.startAt).toISOString(),
      timeZone: appointment.timezone || business.timezone || "America/New_York",
    },
    end: {
      dateTime: new Date(appointment.endAt).toISOString(),
      timeZone: appointment.timezone || business.timezone || "America/New_York",
    },
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : undefined,
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
  };
};

class GoogleCalendarProvider extends SchedulingProvider {
  async getAvailability(options) {
    const businessId = this.business._id || this.business.id;
    const { settings } = await getConnectionAndSettings(businessId);

    const slots = await generateInternalSlots({
      ...options,
      business: this.business,
    });
    if (!Array.isArray(slots) || slots.length === 0) return [];

    const timeMin = new Date(
      Math.min(...slots.map((slot) => new Date(slot.startAt).getTime())),
    ).toISOString();
    const timeMax = new Date(
      Math.max(...slots.map((slot) => new Date(slot.endAt).getTime())),
    ).toISOString();
    const calendarIds = settings.availabilityCalendarIds.length
      ? settings.availabilityCalendarIds
      : [settings.bookingCalendarId];
    const response = await googleApiRequest({
      businessId,
      path: "/freeBusy",
      method: "POST",
      body: {
        timeMin,
        timeMax,
        timeZone: this.business.timezone || "America/New_York",
        items: calendarIds.map((id) => ({ id })),
      },
    });
    const calendarErrors = calendarIds.flatMap((calendarId) =>
      (response.calendars?.[calendarId]?.errors || []).map((error) => ({
        calendarId,
        reason: error.reason || error.domain || "unavailable",
      })),
    );
    if (calendarErrors.length) {
      const error = new Error(
        "One or more Google calendars could not be checked for conflicts.",
      );
      error.statusCode = 409;
      error.code = "GOOGLE_FREE_BUSY_INCOMPLETE";
      error.details = calendarErrors;
      throw error;
    }
    const busy = calendarIds.flatMap(
      (calendarId) => response.calendars?.[calendarId]?.busy || [],
    );
    return slots.filter(
      (slot) => !busy.some((interval) => overlaps(slot, interval)),
    );
  }

  async createAppointment({ appointment, service }) {
    const businessId = this.business._id || this.business.id;
    const { settings } = await getConnectionAndSettings(businessId);
    const body = buildEvent({
      appointment,
      service,
      business: this.business,
      settings,
    });
    let event;
    try {
      event = await googleApiRequest({
        businessId,
        path: `/calendars/${encodeCalendarId(
          settings.bookingCalendarId,
        )}/events?sendUpdates=${encodeURIComponent(settings.sendUpdates)}`,
        method: "POST",
        body,
      });
    } catch (error) {
      if (
        error.statusCode !== 409 &&
        error.providerStatus !== 409 &&
        error.providerPayload?.error?.code !== 409
      ) {
        throw error;
      }
      event = await googleApiRequest({
        businessId,
        path: `/calendars/${encodeCalendarId(
          settings.bookingCalendarId,
        )}/events/${encodeURIComponent(body.id)}`,
      });
    }
    return {
      provider: "google_calendar",
      externalAppointmentId: event.id,
      externalCalendarId: settings.bookingCalendarId,
      raw: event,
    };
  }

  async updateAppointment({ appointment, changes, service }) {
    const businessId = this.business._id || this.business.id;
    const eventId = appointment.externalAppointmentId;
    if (!eventId) {
      throw new Error("The Google event ID is missing from the appointment.");
    }

    const { settings } = await getConnectionAndSettings(businessId);
    const calendarId =
      appointment.externalCalendarId || settings.bookingCalendarId;
    const appointmentObject =
      typeof appointment.toObject === "function"
        ? appointment.toObject()
        : appointment;
    const baseAddress =
      typeof appointment.address?.toObject === "function"
        ? appointment.address.toObject()
        : appointment.address || {};
    const merged = {
      ...appointmentObject,
      ...changes,
      address: { ...baseAddress, ...(changes.address || {}) },
    };
    const body = buildEvent({
      appointment: merged,
      service,
      business: this.business,
      settings,
    });
    delete body.id;
    const event = await googleApiRequest({
      businessId,
      path: `/calendars/${encodeCalendarId(calendarId)}/events/${encodeURIComponent(
        eventId,
      )}?sendUpdates=${encodeURIComponent(settings.sendUpdates)}`,
      method: "PATCH",
      body,
    });
    return {
      provider: "google_calendar",
      externalAppointmentId: event.id,
      externalCalendarId: calendarId,
      raw: event,
    };
  }

  async cancelAppointment({ appointment }) {
    if (!appointment.externalAppointmentId) {
      return { canceled: true, alreadyMissing: true };
    }

    const businessId = this.business._id || this.business.id;
    const { settings } = await getConnectionAndSettings(businessId);
    const calendarId =
      appointment.externalCalendarId || settings.bookingCalendarId;
    const eventId = appointment.externalAppointmentId;
    try {
      await googleApiRequest({
        businessId,
        path: `/calendars/${encodeCalendarId(calendarId)}/events/${encodeURIComponent(
          eventId,
        )}?sendUpdates=${encodeURIComponent(settings.sendUpdates)}`,
        method: "DELETE",
      });
    } catch (error) {
      if (
        error.statusCode !== 404 &&
        error.providerStatus !== 404 &&
        error.providerPayload?.error?.code !== 404
      ) {
        throw error;
      }
    }
    return { canceled: true };
  }

  async getAppointment({ appointment }) {
    if (!appointment.externalAppointmentId) {
      throw new Error("The Google event ID is missing from the appointment.");
    }

    const businessId = this.business._id || this.business.id;
    const { settings } = await getConnectionAndSettings(businessId);
    const calendarId =
      appointment.externalCalendarId || settings.bookingCalendarId;
    const eventId = appointment.externalAppointmentId;
    return googleApiRequest({
      businessId,
      path: `/calendars/${encodeCalendarId(calendarId)}/events/${encodeURIComponent(
        eventId,
      )}`,
    });
  }

  async testConnection() {
    const businessId = this.business._id || this.business.id;
    const { settings } = await getConnectionAndSettings(businessId);
    const calendar = await googleApiRequest({
      businessId,
      path: `/calendars/${encodeCalendarId(settings.bookingCalendarId)}`,
    });
    return {
      connected: true,
      provider: "google_calendar",
      calendar: {
        id: calendar.id,
        summary: calendar.summary,
        timeZone: calendar.timeZone,
      },
    };
  }
}

export { deterministicEventId };
export default GoogleCalendarProvider;
