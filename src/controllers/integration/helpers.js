





import {
  getGoogleSettings,
} from "../../services/integrations/integrationSettings.service.js";



const sanitizeMetadata = (metadata = {}) => {
  const googleCalendar = metadata.googleCalendar || {};
  const channel = googleCalendar.channel || {};
  const sync = googleCalendar.sync || {};

  return {
    ...metadata,
    ...(metadata.googleCalendar
      ? {
          googleCalendar: {
            ...googleCalendar,
            channel: channel.id
              ? {
                  id: channel.id,
                  resourceId: channel.resourceId || "",
                  resourceUri: channel.resourceUri || "",
                  expiration: channel.expiration || null,
                  calendarId: channel.calendarId || "",
                }
              : {},
            sync: {
              calendarId: sync.calendarId || "",
              lastSyncedAt: sync.lastSyncedAt || null,
              lastSeenCount: Number(sync.lastSeenCount || 0),
              lastReconciledCount: Number(sync.lastReconciledCount || 0),
              hasIncrementalCursor: Boolean(sync.nextSyncToken),
            },
          },
        }
      : {}),
  };
};

const publicStatus = (connection) => {
  if (!connection) return { status: "disconnected" };

  const hasGoogleSettings = Boolean(connection.metadata?.googleCalendar);
  const googleSettings =
    connection.provider === "google_calendar" && hasGoogleSettings
      ? getGoogleSettings(connection)
      : null;
  const result = {
    provider: connection.provider,
    status:
      connection.status === "expired"
        ? "reconnect_required"
        : connection.status,
  };

  const copyWhenDefined = (key, value = connection[key]) => {
    if (value !== undefined) result[key] = value;
  };

  copyWhenDefined("scopes", connection.scopes || connection.grantedScopes);
  copyWhenDefined("providerAccountId");
  copyWhenDefined("providerAccountEmail");
  copyWhenDefined("providerCalendarId");

  const providerCalendarName =
    connection.providerCalendarName ||
    connection.metadata?.selectedCalendarSummary;
  if (providerCalendarName) {
    result.providerCalendarName = providerCalendarName;
  }

  if (
    connection.availabilityCalendarIds !== undefined ||
    hasGoogleSettings
  ) {
    result.availabilityCalendarIds =
      googleSettings?.availabilityCalendarIds ||
      connection.availabilityCalendarIds ||
      [];
  }
  if (hasGoogleSettings) {
    result.syncEnabled = googleSettings?.syncEnabled;
    result.watchEnabled = googleSettings?.watchEnabled;
    result.sendUpdates = googleSettings?.sendUpdates;
    result.settings = {
      bookingCalendarId: googleSettings?.bookingCalendarId || "",
      availabilityCalendarIds:
        googleSettings?.availabilityCalendarIds || [],
      syncEnabled: googleSettings?.syncEnabled !== false,
      watchEnabled: googleSettings?.watchEnabled !== false,
      sendUpdates: googleSettings?.sendUpdates || "all",
      defaultAttendeeEmail: googleSettings?.defaultAttendeeEmail || "",
      includeEstimatedValue:
        googleSettings?.includeEstimatedValue === true,
      customerRemindersEnabled:
        googleSettings?.customerRemindersEnabled !== false,
      reminderHours: googleSettings?.reminderHours || [24, 2],
      postAppointmentFollowUpEnabled:
        googleSettings?.postAppointmentFollowUpEnabled !== false,
      postAppointmentFollowUpDelayHours:
        googleSettings?.postAppointmentFollowUpDelayHours || 2,
      googleChangeApprovalRequired:
        googleSettings?.googleChangeApprovalRequired !== false,
      channel: sanitizeMetadata({ googleCalendar: { channel: googleSettings?.channel || {} } })
        .googleCalendar.channel,
      sync: sanitizeMetadata({ googleCalendar: { sync: googleSettings?.sync || {} } })
        .googleCalendar.sync,
    };
  }

  copyWhenDefined("apiVersion");
  result.metadata = sanitizeMetadata(connection.metadata || {});
  copyWhenDefined("connectedAt");
  copyWhenDefined("lastVerifiedAt");
  copyWhenDefined("disconnectedAt");
  copyWhenDefined("lastSuccessfulSyncAt");
  copyWhenDefined("lastErrorAt");
  copyWhenDefined("lastErrorCode");
  copyWhenDefined("lastErrorMessage");
  copyWhenDefined("updatedAt");

  return result;
};

const frontendBaseUrl = () =>
  String(process.env.FRONTEND_URL || "http://localhost:3001").replace(
    /\/$/,
    "",
  );

const loadGoogleCalendarSyncService = () =>
  import("../../services/integrations/googleCalendarSync.service.js");

const shouldStartWatch = (connection) => {
  const settings = getGoogleSettings(connection);
  return (
    settings.syncEnabled &&
    settings.watchEnabled &&
    String(process.env.GOOGLE_CALENDAR_WEBHOOK_URL || "").startsWith("https://")
  );
};

export { frontendBaseUrl, publicStatus, loadGoogleCalendarSyncService, shouldStartWatch };
