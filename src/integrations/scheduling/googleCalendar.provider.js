import {assertGoogleWriteAvailable} from './googleFinalAvailability.js';
import {googleAvailability} from './googleAvailability.js';
import {invalidateGoogleAvailabilityCache} from './googleAvailabilitySnapshot.js';
export {invalidateGoogleAvailabilityCache} from './googleAvailabilitySnapshot.js';
import { saveStateDocument } from '../../services/stateTransitions/documents.js';
import crypto from "crypto";
import SchedulingProvider from "./schedulingProvider.js";
import {
  getGoogleConnection,
  googleApiRequest,
  listGoogleCalendars,
} from "../../services/integrations/googleCalendarConnection.service.js";
import { getGoogleSettings } from "../../services/integrations/integrationSettings.service.js";
const encode = encodeURIComponent;
const confirmationRequest = (request) => googleApiRequest({ ...request, signal: AbortSignal.timeout(15_000) });
const validEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

const uniqueEmails = (values) => [
  ...new Set(
    values
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(validEmail),
  ),
];

export const deterministicEventId = (appointment) =>
  crypto
    .createHash("sha256")
    .update(
      `${appointment?.business || appointment?.businessId || ""}:${appointment?._id || appointment?.id || ""}`,
    )
    .digest("hex")
    .slice(0, 32);

export const deterministicRestoreEventId = (appointment, changeKey) =>
  crypto
    .createHash("sha256")
    .update(
      `${appointment?.business || appointment?.businessId || ""}:${appointment?._id || appointment?.id || ""}:restore:${String(changeKey || "")}`,
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

export const buildGoogleEvent = ({
  appointment,
  service,
  business,
  settings = {},
}) => {
  const attendees = uniqueEmails([
    appointment.customerEmail,
    settings.defaultAttendeeEmail,
  ]).map((email) => ({ email }));
  const description = [
    `MeekCall appointment: ${appointment._id}`,
    `Customer: ${appointment.customerName || "Customer"}`,
    `Phone: ${appointment.customerPhone || ""}`,
    appointment.customerEmail ? `Email: ${appointment.customerEmail}` : "",
    `Service: ${service?.name || "Service requested"}`,
    `Address: ${addressText(appointment)}`,
    settings.includeEstimatedValue === true
      ? (appointment.estimatedValue == null ? "Not estimated" : `Internal estimated job value: $${Number(appointment.estimatedValue).toLocaleString("en-US")}`)
      : "",
    appointment.notes ? `Notes: ${appointment.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    id: deterministicEventId(appointment),
    summary: `${service?.name || "Service appointment"} — ${appointment.customerName || "Customer"}`,
    location: addressText(appointment),
    description,
    ...(attendees.length ? { attendees } : {}),
    start: {
      dateTime: new Date(appointment.startAt).toISOString(),
      timeZone:
        appointment.timezone || business.timezone || "America/New_York",
    },
    end: {
      dateTime: new Date(appointment.endAt).toISOString(),
      timeZone:
        appointment.timezone || business.timezone || "America/New_York",
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
        callbackiqTenantVersion: "1",
      },
    },
  };
};

const updatedGoogleEvent=({appointment,eventAppointment,changes,service,business,settings})=>{
    const eventOwner = eventAppointment || appointment;
    const baseAppointment =
      typeof eventOwner.toObject === "function"
        ? eventOwner.toObject()
        : eventOwner;
    const baseAddress =
      typeof eventOwner.address?.toObject === "function"
        ? eventOwner.address.toObject()
        : eventOwner.address || {};
    const nextAppointment = {
      ...baseAppointment,
      ...changes,
      address: { ...baseAddress, ...(changes?.address || {}) },
    };
    const body = buildGoogleEvent({
      appointment: nextAppointment,
      service,
      business,
      settings,
    });
    delete body.id;
return {body,nextAppointment};
};

class GoogleCalendarProvider extends SchedulingProvider {
  async getAvailability(options) {
    return googleAvailability({business:this.business,options,normalizeSettings});
  }

  async prepareConfirmation({ appointment }) {
    const businessId = this.business._id || this.business.id;
    const { bookingCalendarId, connection } = await normalizeSettings(businessId);
    const calendarId = bookingCalendarId === "primary"
      ? (await confirmationRequest({ businessId, path: "/calendars/primary" })).id
      : bookingCalendarId;
    if (!calendarId) throw new Error("Google did not return the writable calendar ID.");
    return { calendarId, eventId: deterministicEventId(appointment), accountId: connection.providerAccountId };
  }

  async assertConfirmationRetryTarget({ appointment, target }) {
    const current = await this.prepareConfirmation({ appointment });
    if (current.calendarId !== target.calendarId) {
      throw Object.assign(new Error("The booking calendar changed after this confirmation started."),
        { code: "GOOGLE_CONFIRMATION_CALENDAR_CHANGED" });
    }
  }

  async findConfirmation({ appointment, target }) {
    const businessId = this.business._id || this.business.id;
    const { connection } = await normalizeSettings(businessId);
    this.assertConfirmationAccount(target, connection);
    const calendarPath = `/calendars/${encode(target.calendarId)}`;
    const event = await confirmationRequest({
      businessId,
      path: `${calendarPath}/events/${encode(target.eventId)}`,
      allowStatuses: [404, 410],
    });
    if (event?.__providerStatus === 404 || event?.__providerStatus === 410) {
      // A missing calendar and a missing event both return 404.
      await confirmationRequest({ businessId, path: calendarPath });
      return null;
    }
    this.assertConfirmationEvent(appointment, target, event);
    return { provider: "google_calendar", externalAppointmentId: event.id,
      externalCalendarId: target.calendarId, raw: event };
  }

  assertConfirmationAccount(target, connection) {
    if (target.accountId && target.accountId !== connection.providerAccountId) {
      throw Object.assign(new Error("Restore access to the original Google Calendar account to reconcile confirmation."),
        { code: "GOOGLE_CONFIRMATION_ACCOUNT_CHANGED" });
    }
  }

  assertConfirmationEvent(appointment, target, event) {
    const properties = event?.extendedProperties?.private;
    if (event?.status === "cancelled") {
      throw Object.assign(new Error("The Google Calendar event was canceled before confirmation could be saved."),
        { code: "GOOGLE_CONFIRMATION_EVENT_CANCELED", confirmationRejected: true });
    }
    if (event?.id !== target.eventId || properties?.callbackiqAppointmentId !== String(appointment._id) ||
        properties?.callbackiqBusinessId !== String(appointment.business) ||
        new Date(event.start?.dateTime).getTime() !== new Date(appointment.startAt).getTime() ||
        new Date(event.end?.dateTime).getTime() !== new Date(appointment.endAt).getTime()) {
      throw Object.assign(new Error("The Google Calendar event could not be verified against this appointment."),
        { code: "GOOGLE_CONFIRMATION_EVENT_MISMATCH" });
    }
  }

  async createAppointment({ appointment, service, target }) {
    const businessId = this.business._id || this.business.id;
    const { bookingCalendarId: configuredCalendarId, settings, connection, availabilityCalendarIds } =
      await normalizeSettings(businessId);
    if (target) this.assertConfirmationAccount(target, connection);
    const bookingCalendarId = target?.calendarId || configuredCalendarId;
    const request = target ? confirmationRequest : googleApiRequest;
    const eventBody = buildGoogleEvent({
      appointment,
      service,
      business: this.business,
      settings,
    });
    const query = new URLSearchParams({
      sendUpdates: settings.sendUpdates || "all",
    });

    await assertGoogleWriteAvailable({business:this.business,appointment,bookingCalendarId,availabilityCalendarIds,connection});
    let event;
    try {
      event = await request({
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
        if (target && [400, 401, 403, 404, 410, 422].includes(error.providerStatus)) {
          error.confirmationCreateRejected = true;
        }
        throw error;
      }
      event = await request({
        businessId,
        path: `/calendars/${encode(bookingCalendarId)}/events/${encode(eventBody.id)}`,
      });
    }
    if (target) this.assertConfirmationEvent(appointment, target, event);
    await invalidateGoogleAvailabilityCache(businessId);

    return {
      provider: "google_calendar",
      externalAppointmentId: event?.id || eventBody.id,
      externalCalendarId: bookingCalendarId,
      raw: event,
    };
  }

  async restoreAppointment({ appointment, service, changeKey }) {
    const businessId = this.business._id || this.business.id;
    const { bookingCalendarId, settings, connection, availabilityCalendarIds } =
      await normalizeSettings(businessId);
    const eventBody = buildGoogleEvent({
      appointment,
      service,
      business: this.business,
      settings,
    });
    eventBody.id = deterministicRestoreEventId(appointment, changeKey);
    const query = new URLSearchParams({
      sendUpdates: settings.sendUpdates || "all",
    });
    await assertGoogleWriteAvailable({business:this.business,appointment,bookingCalendarId,availabilityCalendarIds,connection});
    let event;
    try {
      event = await googleApiRequest({
        businessId,
        path: `/calendars/${encode(bookingCalendarId)}/events?${query}`,
        method: "POST",
        body: eventBody,
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
        path: `/calendars/${encode(bookingCalendarId)}/events/${encode(eventBody.id)}`,
      });
    }
    await invalidateGoogleAvailabilityCache(businessId);
    return {
      provider: "google_calendar",
      externalAppointmentId: event?.id || eventBody.id,
      externalCalendarId: bookingCalendarId,
      raw: event,
    };
  }

  async updateAppointment({
    appointment,
    changes,
    service,
    eventAppointment = null,
  }) {
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
    const { bookingCalendarId, settings, connection, availabilityCalendarIds } =
      await normalizeSettings(businessId);
    const calendarId = appointment.externalCalendarId || bookingCalendarId;
    // Rescheduling moves the existing Google event but transfers ownership of
    // that event to the replacement MeekCall appointment. Normal updates use
    // the current appointment for both the provider lookup and event metadata.
    const {body,nextAppointment}=updatedGoogleEvent({appointment,eventAppointment,changes,service,business:this.business,settings});
    const query = new URLSearchParams({
      sendUpdates: settings.sendUpdates || "all",
    });
    await assertGoogleWriteAvailable({business:this.business,appointment:nextAppointment,bookingCalendarId:calendarId,availabilityCalendarIds,connection});
    const event = await googleApiRequest({
      businessId,
      path: `/calendars/${encode(calendarId)}/events/${encode(eventId)}?${query}`,
      method: "PUT",
      body,
    });
    await invalidateGoogleAvailabilityCache(businessId);

    return {
      provider: "google_calendar",
      externalAppointmentId: event?.id || eventId,
      externalCalendarId: calendarId,
      raw: event,
    };
  }

  async cancelAppointment({ appointment, target }) {
    if (!appointment.externalAppointmentId) {
      return { canceled: true, alreadyMissing: true };
    }

    const businessId = this.business._id || this.business.id;
    const { bookingCalendarId, settings, connection } =
      await normalizeSettings(businessId);
    if (target) this.assertConfirmationAccount(target, connection);
    const calendarId = appointment.externalCalendarId || bookingCalendarId;
    const query = new URLSearchParams({
      sendUpdates: settings.sendUpdates || "all",
    });
    const request = target ? confirmationRequest : googleApiRequest;
    const result = await request({
      businessId,
      path: `/calendars/${encode(calendarId)}/events/${encode(appointment.externalAppointmentId)}?${query}`,
      method: "DELETE",
      allowStatuses: [404, 410],
    });
    if (target && result?.__providerStatus) {
      await request({ businessId, path: `/calendars/${encode(calendarId)}` });
    }
    await invalidateGoogleAvailabilityCache(businessId);

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
    const { connection, bookingCalendarId } =
      await normalizeSettings(businessId);

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
      await saveStateDocument(connection);
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
