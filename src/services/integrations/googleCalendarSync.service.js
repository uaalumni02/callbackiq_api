import crypto from "crypto";

import Appointment from "../../models/appointment.js";
import Business from "../../models/business.js";
import IntegrationConnection from "../../models/integrationConnection.js";
import InterventionService from "../intervention.service.js";
import { invalidateGoogleAvailabilityCache } from "../../integrations/scheduling/googleCalendar.provider.js";
import {
  getGoogleConnection,
  googleApiRequest,
} from "./googleCalendarConnection.service.js";
import { getGoogleSettings } from "./integrationSettings.service.js";
import {
  approveGoogleProviderChange,
  queueGoogleProviderChange,
} from "./googleCalendarChangeReview.service.js";

const encode = encodeURIComponent;
const isAppointmentObjectId = (value) =>
  /^[a-f0-9]{24}$/i.test(String(value || ""));
const channelToken = () => crypto.randomBytes(32).toString("base64url");
const hashToken = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

const saveGoogleMetadata = async (connection, googleCalendar) => {
  connection.metadata = {
    ...(connection.metadata || {}),
    googleCalendar,
  };
  const channel = googleCalendar.channel || {};
  const sync = googleCalendar.sync || {};
  connection.watchChannelId = channel.id || "";
  connection.watchResourceId = channel.resourceId || "";
  connection.watchExpiresAt = channel.expiration
    ? new Date(channel.expiration)
    : null;
  connection.syncToken = sync.nextSyncToken || "";
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
      /* Clearing local state is required when Google already expired a channel. */
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
    error.code = "GOOGLE_NOT_CONNECTED";
    throw error;
  }
  const settings = getGoogleSettings(connection);
  if (!settings.bookingCalendarId) {
    const error = new Error("Select a booking calendar before enabling sync.");
    error.statusCode = 409;
    error.code = "GOOGLE_CALENDAR_NOT_SELECTED";
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
      tokenHash: hashToken(token),
      expiration: channel.expiration
        ? new Date(Number(channel.expiration)).toISOString()
        : new Date(expiration).toISOString(),
      calendarId: settings.bookingCalendarId,
    },
  });
};

const createCalendarConflict = async ({ appointment, event, reason }) => {
  await InterventionService.create({
    businessId: appointment.business,
    leadId: appointment.lead,
    conversationId: appointment.conversation,
    appointmentId: appointment._id,
    type: "booking_conflict",
    title: "Google Calendar change needs review",
    message:
      "A CallBackIQ appointment was changed directly in Google Calendar and could not be reconciled safely.",
    priority: "high",
    reason,
    recommendedAction:
      "Review the appointment and confirm the correct time with the customer before resolving this alert.",
    metadata: {
      provider: "google_calendar",
      googleEventId: event.id || "",
      googleEventStatus: event.status || "",
    },
    dedupeKey: `google_calendar_conflict:${appointment._id}:${event.sequence || event.updated || event.status || "change"}`,
  });
};

const reconcileEvent = async ({
  business,
  businessId,
  calendarId,
  event,
  settings,
}) => {
  const appointmentId =
    event.extendedProperties?.private?.callbackiqAppointmentId;
  const eventBusinessId =
    event.extendedProperties?.private?.callbackiqBusinessId;
  if (!appointmentId || !isAppointmentObjectId(appointmentId)) return false;

  // Reject events copied from another tenant even when an appointment ID is
  // present. Legacy events without the tenant marker remain business-scoped by
  // the appointment query below.
  if (eventBusinessId && String(eventBusinessId) !== String(businessId)) {
    return false;
  }

  const appointment = await Appointment.findOne({
    _id: appointmentId,
    business: businessId,
  });
  if (!appointment) return false;

  if (event.status === "cancelled") {
    if (["canceled", "completed", "no_show"].includes(appointment.status)) {
      return true;
    }
    await queueGoogleProviderChange({
      appointment,
      calendarId,
      event,
      type: "cancel",
    });
    if (settings.googleChangeApprovalRequired !== false) return true;
    await approveGoogleProviderChange({
      business,
      appointmentId: appointment._id,
    });
    return true;
  }

  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date;
  if (!start || !end) return false;

  const nextStart = new Date(start);
  const nextEnd = new Date(end);
  if (
    Number.isNaN(nextStart.getTime()) ||
    Number.isNaN(nextEnd.getTime()) ||
    nextEnd <= nextStart
  ) {
    await createCalendarConflict({
      appointment,
      event,
      reason: "Google returned an invalid appointment time range.",
    });
    return false;
  }

  const changed =
    new Date(appointment.startAt).getTime() !== nextStart.getTime() ||
    new Date(appointment.endAt).getTime() !== nextEnd.getTime();

  if (changed && ["held", "confirmed"].includes(appointment.status)) {
    await queueGoogleProviderChange({
      appointment,
      calendarId,
      event,
      type: "move",
      startAt: nextStart,
      endAt: nextEnd,
    });
    if (settings.googleChangeApprovalRequired !== false) return true;
    await approveGoogleProviderChange({
      business,
      appointmentId: appointment._id,
    });
    return true;
  }

  appointment.externalAppointmentId = event.id;
  appointment.externalCalendarId = calendarId;
  appointment.provider = "google_calendar";
  await appointment.save();
  return true;
};

export const syncGoogleCalendar = async ({
  businessId,
  forceFull = false,
}) => {
  const connection = await getGoogleConnection(businessId);
  if (!connection || connection.status !== "connected") {
    const error = new Error("Google Calendar is not connected.");
    error.statusCode = 409;
    error.code = "GOOGLE_NOT_CONNECTED";
    throw error;
  }
  const settings = getGoogleSettings(connection);
  const business = await Business.findById(businessId);
  if (!business) {
    const error = new Error("Business not found.");
    error.statusCode = 404;
    throw error;
  }
  const calendarId = settings.bookingCalendarId;
  if (!calendarId) {
    const error = new Error("Select a booking calendar before syncing.");
    error.statusCode = 409;
    error.code = "GOOGLE_CALENDAR_NOT_SELECTED";
    throw error;
  }

  const storedSyncToken =
    settings.sync?.calendarId === calendarId
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
        if (
          await reconcileEvent({
            business,
            businessId,
            calendarId,
            event,
            settings,
          })
        ) {
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

  invalidateGoogleAvailabilityCache(businessId);
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
  return {
    calendarId,
    seen,
    reconciled,
    nextSyncToken: Boolean(nextSyncToken),
  };
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

export const sweepOrphanedGoogleEvents = async ({ limitPerBusiness = 50 } = {}) => {
  const connections = await IntegrationConnection.find({
    provider: "google_calendar",
    status: "connected",
  });
  const results = [];
  const timeMin = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  for (const connection of connections) {
    const businessId = connection.business;
    const settings = getGoogleSettings(connection);
    const calendarId = settings.bookingCalendarId;
    if (!calendarId) continue;
    let removed = 0;
    try {
      const params = new URLSearchParams({
        singleEvents: "true",
        showDeleted: "false",
        timeMin,
        timeMax,
        maxResults: String(Math.min(Math.max(limitPerBusiness, 1), 250)),
      });
      params.append(
        "privateExtendedProperty",
        `callbackiqBusinessId=${String(businessId)}`,
      );
      const page = await googleApiRequest({
        businessId,
        path: `/calendars/${encode(calendarId)}/events?${params.toString()}`,
      });
      for (const event of page.items || []) {
        const appointmentId =
          event.extendedProperties?.private?.callbackiqAppointmentId;
        if (
          !appointmentId ||
          !isAppointmentObjectId(appointmentId) ||
          event.status === "cancelled"
        ) {
          continue;
        }
        const appointment = await Appointment.findOne({
          _id: appointmentId,
          business: businessId,
        })
          .select("status createdAt")
          .lean();
        const oldEnough =
          new Date(event.created || event.updated || 0).getTime() <
          Date.now() - 15 * 60_000;
        if (appointment && appointment.status !== "failed") continue;
        if (!oldEnough) continue;
        const query = new URLSearchParams({
          sendUpdates: settings.sendUpdates || "all",
        });
        await googleApiRequest({
          businessId,
          path: `/calendars/${encode(calendarId)}/events/${encode(
            event.id,
          )}?${query}`,
          method: "DELETE",
          allowStatuses: [404, 410],
        });
        removed += 1;
      }
      results.push({ businessId: String(businessId), removed });
    } catch (error) {
      results.push({
        businessId: String(businessId),
        removed,
        error: error.message,
      });
    }
  }
  return results;
};

export { hashToken as hashGoogleChannelToken };
