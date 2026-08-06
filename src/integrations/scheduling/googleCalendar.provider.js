import crypto from "crypto";

import SchedulingProvider from "./schedulingProvider.js";
import Appointment from "../../models/appointment.js";
import { generateInternalSlots } from "../../services/scheduling/slotGenerator.service.js";
import {
  getGoogleConnection,
  googleApiRequest,
  listGoogleCalendars,
} from "../../services/integrations/googleCalendarConnection.service.js";
import { getGoogleSettings } from "../../services/integrations/integrationSettings.service.js";

const encode = encodeURIComponent;
const DEFAULT_CACHE_TTL_MS = 45_000;
const availabilityCache = new Map();

const overlaps = (slot, busy) =>
  new Date(slot.startAt) < new Date(busy.end) &&
  new Date(slot.endAt) > new Date(busy.start);

const eventRange = (event) => ({
  start: event?.start?.dateTime || event?.start?.date,
  end: event?.end?.dateTime || event?.end?.date,
});

const validEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

const uniqueEmails = (values) => [
  ...new Set(
    values
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(validEmail),
  ),
];

const cacheTtlMs = () =>
  Math.max(
    5_000,
    Math.min(
      Number(process.env.GOOGLE_AVAILABILITY_CACHE_TTL_MS) ||
        DEFAULT_CACHE_TTL_MS,
      5 * 60_000,
    ),
  );

const cacheKey = ({ businessId, calendarIds, timeMin, timeMax }) =>
  [
    String(businessId),
    [...calendarIds].sort().join(","),
    timeMin,
    timeMax,
  ].join("|");

export const invalidateGoogleAvailabilityCache = (businessId) => {
  const prefix = `${String(businessId)}|`;
  for (const key of availabilityCache.keys()) {
    if (key.startsWith(prefix)) availabilityCache.delete(key);
  }
};

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
    `CallBackIQ appointment: ${appointment._id}`,
    `Customer: ${appointment.customerName || "Customer"}`,
    `Phone: ${appointment.customerPhone || ""}`,
    appointment.customerEmail ? `Email: ${appointment.customerEmail}` : "",
    `Service: ${service?.name || "Service requested"}`,
    `Address: ${addressText(appointment)}`,
    settings.includeEstimatedValue === true
      ? `Estimated value: $${Number(appointment.estimatedValue || 0).toLocaleString("en-US")}`
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

const fetchAvailabilitySnapshot = async ({
  businessId,
  bookingCalendarId,
  availabilityCalendarIds,
  timeMin,
  timeMax,
  timeZone,
}) => {
  const key = cacheKey({
    businessId,
    calendarIds: availabilityCalendarIds,
    timeMin,
    timeMax,
  });
  const cached = availabilityCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [freeBusy, bookingEventsPage] = await Promise.all([
    googleApiRequest({
      businessId,
      path: "/freeBusy",
      method: "POST",
      body: {
        timeMin,
        timeMax,
        timeZone,
        items: availabilityCalendarIds.map((id) => ({ id })),
      },
    }),
    googleApiRequest({
      businessId,
      path: `/calendars/${encode(bookingCalendarId)}/events?${new URLSearchParams(
        {
          singleEvents: "true",
          showDeleted: "false",
          timeMin,
          timeMax,
          maxResults: "2500",
        },
      ).toString()}`,
    }),
  ]);

  const calendarResults = freeBusy?.calendars || {};
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

  const bookingEventsListed = Array.isArray(bookingEventsPage?.items);
  const bookingEvents = (bookingEventsPage?.items || []).filter((event) => {
    if (event.status === "cancelled" || event.transparency === "transparent") {
      return false;
    }
    const range = eventRange(event);
    return range.start && range.end;
  });
  const callbackAppointmentIds = [
    ...new Set(
      bookingEvents
        .map(
          (event) =>
            event.extendedProperties?.private?.callbackiqAppointmentId,
        )
        .filter(Boolean),
    ),
  ];
  // Google extended properties are user-editable. Ignore malformed appointment
  // IDs instead of allowing an arbitrary calendar event to trigger a Mongoose
  // CastError and take the business's availability endpoint down.
  const queryableAppointmentIds = callbackAppointmentIds.filter((value) =>
    /^[a-f0-9]{24}$/i.test(String(value)),
  );
  const activeMirroredIds = queryableAppointmentIds.length
    ? new Set(
        (
          await Appointment.find({
            _id: { $in: queryableAppointmentIds },
            business: businessId,
            status: { $in: ["held", "confirmed"] },
          })
            .select("_id")
            .lean()
        ).map((appointment) => String(appointment._id)),
      )
    : new Set();

  const externalBookingEvents = bookingEvents.filter((event) => {
    const privateProperties = event.extendedProperties?.private || {};
    const appointmentId = privateProperties.callbackiqAppointmentId;
    const eventBusinessId = privateProperties.callbackiqBusinessId;
    return !(
      appointmentId &&
      String(eventBusinessId || businessId) === String(businessId) &&
      activeMirroredIds.has(String(appointmentId))
    );
  });
  const value = {
    calendarResults,
    externalBookingEvents,
    bookingEventsListed,
  };
  availabilityCache.set(key, {
    value,
    expiresAt: Date.now() + cacheTtlMs(),
  });

  if (availabilityCache.size > 250) {
    const oldest = availabilityCache.keys().next().value;
    if (oldest) availabilityCache.delete(oldest);
  }
  return value;
};

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

    const { bookingCalendarId, availabilityCalendarIds } =
      await normalizeSettings(businessId);
    if (!Array.isArray(slots) || slots.length === 0) return [];

    const timeMin = new Date(
      Math.min(...slots.map((slot) => new Date(slot.startAt).getTime())),
    ).toISOString();
    const timeMax = new Date(
      Math.max(...slots.map((slot) => new Date(slot.endAt).getTime())),
    ).toISOString();
    const {
      calendarResults,
      externalBookingEvents,
      bookingEventsListed,
    } = await fetchAvailabilitySnapshot({
        businessId,
        bookingCalendarId,
        availabilityCalendarIds,
        timeMin,
        timeMax,
        timeZone: this.business.timezone || "America/New_York",
      });

    const otherCalendarIds = availabilityCalendarIds.filter(
      (id) => id !== bookingCalendarId,
    );
    return slots.filter((slot) => {
      const remainingCapacity = Math.max(
        0,
        Number(slot.remainingCapacity ?? slot.capacity ?? 1),
      );
      if (remainingCapacity === 0) return false;

      // Each selected non-booking calendar represents one external resource
      // lane. The booking calendar can contain multiple manually-created jobs,
      // so count its non-CallBackIQ events individually.
      const otherBusyLanes = otherCalendarIds.filter((calendarId) =>
        (calendarResults[calendarId]?.busy || []).some((interval) =>
          overlaps(slot, interval),
        ),
      ).length;
      const bookingBusyLanes = bookingEventsListed
        ? externalBookingEvents.filter(
            (event) =>
              event.id !== options.excludeExternalEventId &&
              overlaps(slot, eventRange(event)),
          ).length
        : (calendarResults[bookingCalendarId]?.busy || []).filter((interval) =>
            overlaps(slot, interval),
          ).length;

      return otherBusyLanes + bookingBusyLanes < remainingCapacity;
    });
  }

  async createAppointment({ appointment, service }) {
    const businessId = this.business._id || this.business.id;
    const { bookingCalendarId, settings } =
      await normalizeSettings(businessId);
    const eventBody = buildGoogleEvent({
      appointment,
      service,
      business: this.business,
      settings,
    });
    const query = new URLSearchParams({
      sendUpdates: settings.sendUpdates || "all",
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
    invalidateGoogleAvailabilityCache(businessId);

    return {
      provider: "google_calendar",
      externalAppointmentId: event?.id || eventBody.id,
      externalCalendarId: bookingCalendarId,
      raw: event,
    };
  }

  async restoreAppointment({ appointment, service, changeKey }) {
    const businessId = this.business._id || this.business.id;
    const { bookingCalendarId, settings } =
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
    invalidateGoogleAvailabilityCache(businessId);
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
    const { bookingCalendarId, settings } =
      await normalizeSettings(businessId);
    const calendarId = appointment.externalCalendarId || bookingCalendarId;
    // Rescheduling moves the existing Google event but transfers ownership of
    // that event to the replacement CallBackIQ appointment. Normal updates use
    // the current appointment for both the provider lookup and event metadata.
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
      business: this.business,
      settings,
    });
    delete body.id;
    const query = new URLSearchParams({
      sendUpdates: settings.sendUpdates || "all",
    });
    const event = await googleApiRequest({
      businessId,
      path: `/calendars/${encode(calendarId)}/events/${encode(eventId)}?${query}`,
      method: "PUT",
      body,
    });
    invalidateGoogleAvailabilityCache(businessId);

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
    const { bookingCalendarId, settings } =
      await normalizeSettings(businessId);
    const calendarId = appointment.externalCalendarId || bookingCalendarId;
    const query = new URLSearchParams({
      sendUpdates: settings.sendUpdates || "all",
    });
    const result = await googleApiRequest({
      businessId,
      path: `/calendars/${encode(calendarId)}/events/${encode(appointment.externalAppointmentId)}?${query}`,
      method: "DELETE",
      allowStatuses: [404, 410],
    });
    invalidateGoogleAvailabilityCache(businessId);

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
