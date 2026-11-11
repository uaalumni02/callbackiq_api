import { Business, disconnectGoogleCalendar, getGoogleSettings, getOwnedBusiness, loadGoogleCalendarSyncService, publicStatus, refreshUpcomingAppointmentNotifications, selectGoogleCalendar, shouldStartWatch } from './context.js';

export default class IntegrationGoogleSettingsController {
static async googleSelectCalendar(req, res, next) {
    try {
      const payload = req.body?.settings || req.body || {};
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body?.businessId || payload.businessId,
      });
      const hasAdvancedSelection =
        payload.bookingCalendarId !== undefined ||
        payload.providerCalendarId !== undefined ||
        payload.availabilityCalendarIds !== undefined ||
        payload.syncEnabled !== undefined ||
        payload.watchEnabled !== undefined ||
        payload.sendUpdates !== undefined ||
        payload.defaultAttendeeEmail !== undefined ||
        payload.includeEstimatedValue !== undefined ||
        payload.customerRemindersEnabled !== undefined ||
        payload.reminderHours !== undefined ||
        payload.postAppointmentFollowUpEnabled !== undefined ||
        payload.postAppointmentFollowUpDelayHours !== undefined ||
        payload.googleChangeApprovalRequired !== undefined;
      let connection = await selectGoogleCalendar(
        hasAdvancedSelection
          ? {
              businessId: business._id,
              calendarId: payload.calendarId,
              bookingCalendarId:
                payload.bookingCalendarId || payload.providerCalendarId,
              availabilityCalendarIds: payload.availabilityCalendarIds,
              syncEnabled: payload.syncEnabled,
              watchEnabled: payload.watchEnabled,
              sendUpdates: payload.sendUpdates,
              defaultAttendeeEmail: payload.defaultAttendeeEmail,
              includeEstimatedValue: payload.includeEstimatedValue,
              customerRemindersEnabled: payload.customerRemindersEnabled,
              reminderHours: payload.reminderHours,
              postAppointmentFollowUpEnabled:
                payload.postAppointmentFollowUpEnabled,
              postAppointmentFollowUpDelayHours:
                payload.postAppointmentFollowUpDelayHours,
              googleChangeApprovalRequired:
                payload.googleChangeApprovalRequired,
            }
          : {
              businessId: business._id,
              calendarId: payload.calendarId,
            },
      );

      let watch = null;
      const settings = getGoogleSettings(connection);
      if (
        settings.syncEnabled &&
        settings.watchEnabled &&
        shouldStartWatch(connection)
      ) {
        try {
          const { startGoogleCalendarWatch } =
            await loadGoogleCalendarSyncService();
          connection = await startGoogleCalendarWatch(business._id);
          watch = {
            enabled: true,
            expiration:
              connection.metadata?.googleCalendar?.channel?.expiration || null,
          };
        } catch (watchError) {
          watch = {
            enabled: false,
            warning: watchError.message,
          };
        }
      } else if (
        (!settings.syncEnabled || !settings.watchEnabled) &&
        settings.channel?.id
      ) {
        const { stopGoogleCalendarWatch } =
          await loadGoogleCalendarSyncService();
        connection = await stopGoogleCalendarWatch(business._id);
        watch = { enabled: false };
      } else if (
        settings.watchEnabled &&
        !String(process.env.GOOGLE_CALENDAR_WEBHOOK_URL || "").startsWith(
          "https://",
        )
      ) {
        watch = {
          enabled: false,
          warning:
            "Live Google change notifications will start after GOOGLE_CALENDAR_WEBHOOK_URL is configured with a public HTTPS URL.",
        };
      }

      let reminderRefresh = null;
      try {
        reminderRefresh = await refreshUpcomingAppointmentNotifications({
          businessId: business._id,
          limit: 250,
        });
      } catch (reminderError) {
        reminderRefresh = {
          refreshed: 0,
          warning: reminderError.message,
        };
      }

      await Business.updateOne(
        { _id: business._id },
        {
          $set: {
            "features.calendarProvider": "google",
            "integrations.calendar.provider": "google",
            "integrations.calendar.status": "connected",
            "integrations.calendar.verified": true,
            "integrations.calendar.verifiedAt": new Date(),
          },
        },
      );
      return res.status(200).json({
        success: true,
        data: {
          ...publicStatus(connection),
          watch,
          reminderRefresh,
        },
      });
    } catch (error) {
      return next(error);
    }
  }

static async googleSaveSettings(req, res, next) {
    return IntegrationGoogleSettingsController.googleSelectCalendar(req, res, next);
  }

static async googleDisconnect(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body?.businessId || req.query.businessId,
      });
      const connection = await disconnectGoogleCalendar(business._id);
      await Business.updateOne(
        { _id: business._id },
        {
          $set: {
            "features.calendarProvider": "internal",
            "integrations.calendar.provider": "internal",
            "integrations.calendar.status": "disconnected",
            "integrations.calendar.verified": false,
            "integrations.calendar.verifiedAt": null,
          },
        },
      );
      return res.status(200).json({
        success: true,
        data: publicStatus(connection),
      });
    } catch (error) {
      return next(error);
    }
  }
}
