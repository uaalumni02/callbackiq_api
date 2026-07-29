import Business from "../models/business.js";
import IntegrationConnection from "../models/integrationConnection.js";
import GoogleCalendarProvider from "../integrations/scheduling/googleCalendar.provider.js";
import JobberProvider from "../integrations/scheduling/jobber.provider.js";
import getOwnedBusiness from "../services/businessScope.service.js";
import {
  buildGoogleAuthorizationUrl,
  disconnectGoogleCalendar,
  exchangeGoogleAuthorizationCode,
  getGoogleConnection,
  listGoogleCalendars,
  selectGoogleCalendar,
} from "../services/integrations/googleCalendarConnection.service.js";
import {
  getGoogleSettings,
} from "../services/integrations/integrationSettings.service.js";
import {
  buildJobberAuthorizationUrl,
  disconnectJobber,
  exchangeJobberAuthorizationCode,
} from "../services/integrations/jobberOAuth.service.js";

const sanitizeMetadata = (metadata = {}) => {
  const googleCalendar = metadata.googleCalendar || {};
  const channel = googleCalendar.channel || {};

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
  import("../services/integrations/googleCalendarSync.service.js");

const shouldStartWatch = (connection) => {
  const settings = getGoogleSettings(connection);
  return (
    settings.watchEnabled &&
    String(process.env.GOOGLE_CALENDAR_WEBHOOK_URL || "").startsWith("https://")
  );
};

class IntegrationController {
  static async googleConnect(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const authorizationUrl = await buildGoogleAuthorizationUrl(
        business._id,
        req.user?.userId,
      );
      return res.status(200).json({
        success: true,
        data: { authorizationUrl },
      });
    } catch (error) {
      return next(error);
    }
  }

  static async googleCallback(req, res) {
    const frontendUrl = frontendBaseUrl();
    try {
      if (!req.query.code || !req.query.state) {
        throw new Error(
          "Google did not return an authorization code and state.",
        );
      }
      const { businessId } = await exchangeGoogleAuthorizationCode({
        code: req.query.code,
        state: req.query.state,
      });
      await Business.updateOne(
        { _id: businessId },
        {
          $set: {
            "integrations.calendar.provider": "google",
            "integrations.calendar.status": "connected",
            "integrations.calendar.verified": false,
            "integrations.calendar.verifiedAt": null,
          },
        },
      );
      return res.redirect(`${frontendUrl}/integrations?google=connected`);
    } catch (error) {
      const message = encodeURIComponent(
        error.message || "Google Calendar connection failed",
      );
      return res.redirect(
        `${frontendUrl}/integrations?google=error&message=${message}`,
      );
    }
  }

  static async googleStatus(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const connection = await getGoogleConnection(business._id);
      return res.status(200).json({
        success: true,
        data: publicStatus(connection),
      });
    } catch (error) {
      return next(error);
    }
  }

  static async googleCalendars(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const calendars = await listGoogleCalendars(business._id, true);
      return res.status(200).json({ success: true, data: calendars });
    } catch (error) {
      return next(error);
    }
  }

  static async googleSelectCalendar(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body.businessId,
      });
      const hasAdvancedSelection =
        req.body.bookingCalendarId !== undefined ||
        req.body.providerCalendarId !== undefined ||
        req.body.availabilityCalendarIds !== undefined ||
        req.body.syncEnabled !== undefined ||
        req.body.watchEnabled !== undefined ||
        req.body.sendUpdates !== undefined;
      let connection = await selectGoogleCalendar(
        hasAdvancedSelection
          ? {
              businessId: business._id,
              calendarId: req.body.calendarId,
              bookingCalendarId:
                req.body.bookingCalendarId || req.body.providerCalendarId,
              availabilityCalendarIds: req.body.availabilityCalendarIds,
              syncEnabled: req.body.syncEnabled,
              watchEnabled: req.body.watchEnabled,
              sendUpdates: req.body.sendUpdates,
            }
          : {
              businessId: business._id,
              calendarId: req.body.calendarId,
            },
      );

      let watch = null;
      if (shouldStartWatch(connection)) {
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
        },
      });
    } catch (error) {
      return next(error);
    }
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

  static async googleTest(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body?.businessId,
      });
      const result = await new GoogleCalendarProvider({
        business,
      }).testConnection();
      await Business.updateOne(
        { _id: business._id },
        {
          $set: {
            "integrations.calendar.status": "connected",
            "integrations.calendar.verified": true,
            "integrations.calendar.verifiedAt": new Date(),
          },
        },
      );
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  }

  static async googleSync(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body?.businessId,
      });
      const { syncGoogleCalendar } = await loadGoogleCalendarSyncService();
      const result = await syncGoogleCalendar({
        businessId: business._id,
        forceFull: req.body?.forceFull === true,
      });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  }

  static async googleStartWatch(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body?.businessId,
      });
      const { startGoogleCalendarWatch } =
        await loadGoogleCalendarSyncService();
      const connection = await startGoogleCalendarWatch(business._id);
      return res.status(200).json({
        success: true,
        data: publicStatus(connection),
      });
    } catch (error) {
      return next(error);
    }
  }

  static async googleStopWatch(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body?.businessId || req.query.businessId,
      });
      const { stopGoogleCalendarWatch } =
        await loadGoogleCalendarSyncService();
      const connection = await stopGoogleCalendarWatch(business._id);
      return res.status(200).json({
        success: true,
        data: publicStatus(connection),
      });
    } catch (error) {
      return next(error);
    }
  }

  static async jobberConnect(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const authorizationUrl = await buildJobberAuthorizationUrl(business._id);
      return res.status(200).json({
        success: true,
        data: { authorizationUrl },
      });
    } catch (error) {
      return next(error);
    }
  }

  static async jobberCallback(req, res) {
    const frontendUrl = frontendBaseUrl();
    try {
      if (!req.query.code || !req.query.state) {
        throw new Error(
          "Jobber did not return an authorization code and state.",
        );
      }
      const { businessId } = await exchangeJobberAuthorizationCode({
        code: req.query.code,
        state: req.query.state,
      });
      await Business.updateOne(
        { _id: businessId },
        {
          $set: {
            "integrations.dispatch.provider": "jobber",
            "integrations.dispatch.status": "connected",
            "integrations.dispatch.verified": true,
            "integrations.dispatch.verifiedAt": new Date(),
          },
        },
      );
      return res.redirect(`${frontendUrl}/integrations?jobber=connected`);
    } catch (error) {
      const message = encodeURIComponent(
        error.message || "Jobber connection failed",
      );
      return res.redirect(
        `${frontendUrl}/integrations?jobber=error&message=${message}`,
      );
    }
  }

  static async jobberDisconnect(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body.businessId,
      });
      const connection = await disconnectJobber(business._id);
      await Business.updateOne(
        { _id: business._id },
        {
          $set: {
            "integrations.dispatch.provider": "",
            "integrations.dispatch.status": "disconnected",
            "integrations.dispatch.verified": false,
            "integrations.dispatch.verifiedAt": null,
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

  static async jobberStatus(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const connection = await IntegrationConnection.findOne({
        business: business._id,
        provider: "jobber",
      });
      return res.status(200).json({
        success: true,
        data: publicStatus(connection),
      });
    } catch (error) {
      return next(error);
    }
  }

  static async jobberTest(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body.businessId,
      });
      const result = await new JobberProvider({ business }).testConnection();
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  }
}

export default IntegrationController;
