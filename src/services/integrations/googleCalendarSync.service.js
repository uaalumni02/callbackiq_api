import crypto from "crypto";

import Appointment from "../../models/appointment.js";
import IntegrationConnection from "../../models/integrationConnection.js";
import {
  getGoogleConnection,
  googleApiRequest,
} from "./googleCalendarConnection.service.js";
import { getGoogleSettings } from "./integrationSettings.service.js";

const encode = encodeURIComponent;
const channelToken = () => crypto.randomBytes(32).toString("base64url");

const saveGoogleMetadata = async (connection, googleCalendar) => {
  connection.metadata = {
    ...(connection.metadata || {}),
    googleCalendar,
  };
  connection.markModified("metadata");
  await connection.save();
  return connection;
};

export const stopGoogleCalendarWatch = async (businessId) => {
  const connection = await getGoogleConnection(businessId);
  if (!connection) return null;
  const settings = getGoogleSettings(connection);
  const channel = settings.channel || {};
  if (channel.id && channel.resourceId) {
    try {
      await googleApiRequest({
        businessId,
        path: "/channels/stop",
        method: "POST",
        body: { id: channel.id, resourceId: channel.resourceId },
      });
    } catch {
      // Clearing the local channel is still required when Google has expired it.
    }
  }
  return saveGoogleMetadata(connection, {
    ...(connection.metadata?.googleCalendar || {}),
    channel: {},
  });
};

export const startGoogleCalendarWatch = async (businessId) => {
  const webhookUrl = String(
    process.env.GOOGLE_CALENDAR_WEBHOOK_URL || "",
  ).trim();
  if (!webhookUrl.startsWith("https://")) {
    const error = new Error(
      "GOOGLE_CALENDAR_WEBHOOK_URL must be a public HTTPS URL.",
    );
    error.statusCode = 503;
    error.code = "GOOGLE_WEBHOOK_NOT_CONFIGURED";
    throw error;
  }
  const connection = await getGoogleConnection(businessId);
  if (!connection || connection.status !== "connected") {
    const error = new Error("Google Calendar is not connected.");
    error.statusCode = 409;
    throw error;
  }
  const settings = getGoogleSettings(connection);
  if (!settings.bookingCalendarId) {
    const error = new Error("Select a booking calendar before enabling sync.");
    error.statusCode = 409;
    throw error;
  }

  if (settings.channel?.id) await stopGoogleCalendarWatch(businessId);
  const id = crypto.randomUUID();
  const token = channelToken();
  const expiration = Date.now() + 6 * 24 * 60 * 60 * 1000;
  const channel = await googleApiRequest({
    businessId,
    path: `/calendars/${encode(settings.bookingCalendarId)}/events/watch`,
    method: "POST",
    body: {
      id,
      type: "web_hook",
      address: webhookUrl,
      token,
      expiration,
    },
  });

  return saveGoogleMetadata(connection, {
    ...(connection.metadata?.googleCalendar || {}),
    channel: {
      id: channel.id || id,
      resourceId: channel.resourceId,
      resourceUri: channel.resourceUri,
      token,
      expiration: channel.expiration
        ? new Date(Number(channel.expiration)).toISOString()
        : new Date(expiration).toISOString(),
      calendarId: settings.bookingCalendarId,
    },
  });
};

const reconcileEvent = async ({ businessId, calendarId, event }) => {
  const appointmentId =
    event.extendedProperties?.private?.callbackiqAppointmentId;
  if (!appointmentId) return false;
  const appointment = await Appointment.findOne({
    _id: appointmentId,
    business: businessId,
  });
  if (!appointment) return false;

  if (event.status === "cancelled") {
    if (!["canceled", "completed", "no_show"].includes(appointment.status)) {
      appointment.status = "canceled";
      appointment.canceledAt = new Date();
      appointment.activeSlotKey = null;
      appointment.slotClaimKeys = [];
    }
  } else {
    const start = event.start?.dateTime || event.start?.date;
    const end = event.end?.dateTime || event.end?.date;
    if (start && end) {
      appointment.startAt = new Date(start);
      appointment.endAt = new Date(end);
    }
    appointment.externalAppointmentId = event.id;
    appointment.externalCalendarId = calendarId;
    appointment.provider = "google_calendar";
  }
  await appointment.save();
  return true;
};

export const syncGoogleCalendar = async ({ businessId, forceFull = false }) => {
  const connection = await getGoogleConnection(businessId);
  if (!connection || connection.status !== "connected") {
    const error = new Error("Google Calendar is not connected.");
    error.statusCode = 409;
    throw error;
  }
  const settings = getGoogleSettings(connection);
  const calendarId = settings.bookingCalendarId;
  if (!calendarId) {
    const error = new Error("Select a booking calendar before syncing.");
    error.statusCode = 409;
    throw error;
  }

  const storedSyncToken = settings.sync?.calendarId === calendarId
    ? settings.sync?.nextSyncToken
    : "";
  let syncToken = forceFull ? "" : storedSyncToken;
  let pageToken = "";
  let nextSyncToken = "";
  let reconciled = 0;
  let seen = 0;

  const run = async () => {
    do {
      const params = new URLSearchParams({
        singleEvents: "true",
        showDeleted: "true",
        maxResults: "2500",
      });
      if (syncToken) params.set("syncToken", syncToken);
      else {
        params.set(
          "timeMin",
          new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        );
      }
      if (pageToken) params.set("pageToken", pageToken);
      const page = await googleApiRequest({
        businessId,
        path: `/calendars/${encode(calendarId)}/events?${params.toString()}`,
      });
      for (const event of page.items || []) {
        seen += 1;
        if (await reconcileEvent({ businessId, calendarId, event })) {
          reconciled += 1;
        }
      }
      pageToken = page.nextPageToken || "";
      nextSyncToken = page.nextSyncToken || nextSyncToken;
    } while (pageToken);
  };

  try {
    await run();
  } catch (error) {
    const isExpiredToken =
      error.providerStatus === 410 ||
      error.statusCode === 410 ||
      error.providerPayload?.error?.code === 410 ||
      /sync token|full sync/i.test(error.message || "");
    if (!syncToken || !isExpiredToken) throw error;
    syncToken = "";
    pageToken = "";
    nextSyncToken = "";
    await run();
  }

  await saveGoogleMetadata(connection, {
    ...(connection.metadata?.googleCalendar || {}),
    sync: {
      calendarId,
      nextSyncToken,
      lastSyncedAt: new Date().toISOString(),
      lastSeenCount: seen,
      lastReconciledCount: reconciled,
    },
  });
  return { calendarId, seen, reconciled, nextSyncToken: Boolean(nextSyncToken) };
};

export const renewExpiringGoogleWatches = async () => {
  const connections = await IntegrationConnection.find({
    provider: "google_calendar",
    status: "connected",
  });
  const results = [];
  for (const connection of connections) {
    const settings = getGoogleSettings(connection);
    if (!settings.watchEnabled || !settings.bookingCalendarId) continue;
    const expiration = settings.channel?.expiration
      ? new Date(settings.channel.expiration).getTime()
      : 0;
    if (expiration > Date.now() + 24 * 60 * 60 * 1000) continue;
    try {
      await startGoogleCalendarWatch(connection.business);
      results.push({ businessId: String(connection.business), renewed: true });
    } catch (error) {
      results.push({
        businessId: String(connection.business),
        renewed: false,
        error: error.message,
      });
    }
  }
  return results;
};
