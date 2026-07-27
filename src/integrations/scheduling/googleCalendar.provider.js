import SchedulingProvider from "./schedulingProvider.js";
import { generateInternalSlots } from "../../services/scheduling/slotGenerator.service.js";
import {
  getGoogleConnection,
  googleApiRequest,
} from "../../services/integrations/googleCalendarConnection.service.js";

const encodeCalendarId = (value) => encodeURIComponent(value);

const overlaps = (slot, busy) =>
  new Date(slot.startAt) < new Date(busy.end) &&
  new Date(slot.endAt) > new Date(busy.start);

const getCalendarId = async (businessId) => {
  const connection = await getGoogleConnection(businessId);
  const calendarId = connection?.providerCalendarId;

  if (!calendarId) {
    const error = new Error("Select a writable Google Calendar before booking.");
    error.statusCode = 409;
    error.code = "GOOGLE_CALENDAR_NOT_SELECTED";
    throw error;
  }

  return calendarId;
};

const buildEvent = ({ appointment, service, business }) => ({
  summary: `${service?.name || "Service appointment"} — ${appointment.customerName || "Customer"}`,
  description: [
    `CallBackIQ appointment: ${appointment._id}`,
    `Customer: ${appointment.customerName || "Customer"}`,
    `Phone: ${appointment.customerPhone || ""}`,
    `Email: ${appointment.customerEmail || ""}`,
    `Service: ${service?.name || "Service requested"}`,
    `Address: ${[
      appointment.address?.street,
      appointment.address?.city,
      appointment.address?.state,
      appointment.address?.postalCode,
    ].filter(Boolean).join(", ")}`,
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
  extendedProperties: {
    private: {
      callbackiqAppointmentId: String(appointment._id),
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
    const calendarId = await getCalendarId(businessId);
    const slots = await generateInternalSlots({ ...options, business: this.business });

    if (slots.length === 0) {
      return [];
    }

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
        items: [{ id: calendarId }],
      },
    });
    const busy = response.calendars?.[calendarId]?.busy || [];

    return slots.filter((slot) => !busy.some((interval) => overlaps(slot, interval)));
  }

  async createAppointment({ appointment, service }) {
    const businessId = this.business._id || this.business.id;
    const calendarId = await getCalendarId(businessId);
    const event = await googleApiRequest({
      businessId,
      path: `/calendars/${encodeCalendarId(calendarId)}/events?sendUpdates=none`,
      method: "POST",
      body: buildEvent({ appointment, service, business: this.business }),
    });

    return {
      provider: "google_calendar",
      externalAppointmentId: event.id,
      externalCalendarId: calendarId,
      raw: event,
    };
  }

  async updateAppointment({ appointment, changes, service }) {
    const businessId = this.business._id || this.business.id;
    const calendarId = appointment.externalCalendarId || (await getCalendarId(businessId));
    const eventId = appointment.externalAppointmentId;

    if (!eventId) {
      throw new Error("The Google event ID is missing from the appointment.");
    }

    const baseAppointment =
      typeof appointment.toObject === "function"
        ? appointment.toObject()
        : appointment;
    const nextAppointment = { ...baseAppointment, ...changes };
    const event = await googleApiRequest({
      businessId,
      path: `/calendars/${encodeCalendarId(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      method: "PATCH",
      body: buildEvent({
        appointment: nextAppointment,
        service,
        business: this.business,
      }),
    });

    return {
      provider: "google_calendar",
      externalAppointmentId: event.id,
      externalCalendarId: calendarId,
      raw: event,
    };
  }

  async cancelAppointment({ appointment }) {
    const businessId = this.business._id || this.business.id;
    const calendarId = appointment.externalCalendarId || (await getCalendarId(businessId));

    if (!appointment.externalAppointmentId) {
      return { canceled: true, alreadyMissing: true };
    }

    await googleApiRequest({
      businessId,
      path: `/calendars/${encodeCalendarId(calendarId)}/events/${encodeURIComponent(appointment.externalAppointmentId)}?sendUpdates=none`,
      method: "DELETE",
    });

    return { canceled: true };
  }

  async getAppointment({ appointment }) {
    const businessId = this.business._id || this.business.id;
    const calendarId = appointment.externalCalendarId || (await getCalendarId(businessId));

    return googleApiRequest({
      businessId,
      path: `/calendars/${encodeCalendarId(calendarId)}/events/${encodeURIComponent(appointment.externalAppointmentId)}`,
    });
  }

  async testConnection() {
    const businessId = this.business._id || this.business.id;
    const calendarId = await getCalendarId(businessId);
    const calendar = await googleApiRequest({
      businessId,
      path: `/calendars/${encodeCalendarId(calendarId)}`,
    });

    return {
      connected: true,
      provider: "google_calendar",
      calendar: { id: calendar.id, summary: calendar.summary, timeZone: calendar.timeZone },
    };
  }
}

export default GoogleCalendarProvider;
