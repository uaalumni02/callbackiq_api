import IntegrationConnection from "../../models/integrationConnection.js";
import { listGoogleCalendarDirectory } from "./googleCalendarDirectory.service.js";


const boundedNumber = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
};

const uniqueStrings = (values) => [
  ...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  ),
];

export const getGoogleSettings = (connection) => {
  const stored = connection?.metadata?.googleCalendar || {};
  const bookingCalendarId = String(
    stored.bookingCalendarId || connection?.providerCalendarId || "",
  ).trim();
  const availabilityCalendarIds = uniqueStrings(
    stored.availabilityCalendarIds?.length
      ? stored.availabilityCalendarIds
      : bookingCalendarId
        ? [bookingCalendarId]
        : [],
  );

  return {
    bookingCalendarId,
    availabilityCalendarIds,
    syncEnabled: stored.syncEnabled !== false,
    watchEnabled: stored.watchEnabled !== false,
    sendUpdates: ["all", "externalOnly", "none"].includes(stored.sendUpdates)
      ? stored.sendUpdates
      : "none",
    defaultAttendeeEmail: String(stored.defaultAttendeeEmail || "").trim(),
    channel: stored.channel || {},
    sync: stored.sync || {},
  };
};

export const saveGoogleSettings = async ({ businessId, settings }) => {
  const connection = await IntegrationConnection.findOne({
    business: businessId,
    provider: "google_calendar",
  });
  if (!connection || connection.status !== "connected") {
    const error = new Error("Google Calendar is not connected.");
    error.statusCode = 409;
    error.code = "GOOGLE_NOT_CONNECTED";
    throw error;
  }

  const bookingCalendarId = String(settings.bookingCalendarId || "").trim();
  const availabilityCalendarIds = uniqueStrings(settings.availabilityCalendarIds);
  if (!bookingCalendarId) {
    const error = new Error("Choose a booking calendar.");
    error.statusCode = 400;
    error.code = "GOOGLE_BOOKING_CALENDAR_REQUIRED";
    throw error;
  }
  if (!availabilityCalendarIds.includes(bookingCalendarId)) {
    availabilityCalendarIds.push(bookingCalendarId);
  }
  if (availabilityCalendarIds.length > 50) {
    const error = new Error("Google availability checks support up to 50 calendars.");
    error.statusCode = 400;
    error.code = "GOOGLE_TOO_MANY_CALENDARS";
    throw error;
  }

  const calendars = await listGoogleCalendarDirectory(businessId);
  const calendarsById = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  const bookingCalendar = calendarsById.get(bookingCalendarId);
  if (!bookingCalendar || !["writer", "owner"].includes(bookingCalendar.accessRole)) {
    const error = new Error("The selected Google booking calendar is not writable.");
    error.statusCode = 400;
    error.code = "GOOGLE_BOOKING_CALENDAR_NOT_WRITABLE";
    throw error;
  }
  const missingCalendar = availabilityCalendarIds.find(
    (calendarId) => !calendarsById.has(calendarId),
  );
  if (missingCalendar) {
    const error = new Error("One or more selected Google calendars are unavailable.");
    error.statusCode = 400;
    error.code = "GOOGLE_CALENDAR_UNAVAILABLE";
    throw error;
  }

  connection.providerCalendarId = bookingCalendarId;
  connection.metadata = {
    ...(connection.metadata || {}),
    googleCalendar: {
      ...(connection.metadata?.googleCalendar || {}),
      bookingCalendarId,
      availabilityCalendarIds,
      syncEnabled: settings.syncEnabled !== false,
      watchEnabled: settings.watchEnabled !== false,
      sendUpdates: ["all", "externalOnly", "none"].includes(settings.sendUpdates)
        ? settings.sendUpdates
        : "none",
      defaultAttendeeEmail: String(settings.defaultAttendeeEmail || "").trim(),
    },
  };
  connection.markModified("metadata");
  await connection.save();
  return connection;
};

export const getJobberSettings = (connection) => {
  const stored = connection?.metadata?.jobber || {};
  return {
    syncQualifiedLeads: stored.syncQualifiedLeads !== false,
    createRequestOn: ["qualified", "confirmed_appointment"].includes(
      stored.createRequestOn,
    )
      ? stored.createRequestOn
      : "qualified",
    updateExistingClients: stored.updateExistingClients !== false,
    createClientWhenMissing: stored.createClientWhenMissing !== false,
    requestTitleTemplate:
      String(stored.requestTitleTemplate || "{{service}} — {{customer}}").trim() ||
      "{{service}} — {{customer}}",
    defaultRequestDetails: String(stored.defaultRequestDetails || "").trim(),
    minimumLeadQualityScore: boundedNumber(
      stored.minimumLeadQualityScore,
      60,
      0,
      100,
    ),
  };
};

export const saveJobberSettings = async ({ businessId, settings }) => {
  const connection = await IntegrationConnection.findOne({
    business: businessId,
    provider: "jobber",
  });
  if (!connection || connection.status !== "connected") {
    const error = new Error("Jobber is not connected.");
    error.statusCode = 409;
    error.code = "JOBBER_NOT_CONNECTED";
    throw error;
  }

  connection.metadata = {
    ...(connection.metadata || {}),
    jobber: {
      ...(connection.metadata?.jobber || {}),
      syncQualifiedLeads: settings.syncQualifiedLeads !== false,
      createRequestOn: ["qualified", "confirmed_appointment"].includes(
        settings.createRequestOn,
      )
        ? settings.createRequestOn
        : "qualified",
      updateExistingClients: settings.updateExistingClients !== false,
      createClientWhenMissing: settings.createClientWhenMissing !== false,
      requestTitleTemplate:
        String(settings.requestTitleTemplate || "{{service}} — {{customer}}").trim() ||
        "{{service}} — {{customer}}",
      defaultRequestDetails: String(settings.defaultRequestDetails || "").trim(),
      minimumLeadQualityScore: boundedNumber(
        settings.minimumLeadQualityScore,
        60,
        0,
        100,
      ),
    },
  };
  connection.markModified("metadata");
  await connection.save();
  return connection;
};
