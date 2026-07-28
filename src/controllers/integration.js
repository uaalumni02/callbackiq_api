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
import { listGoogleCalendarDirectory } from "../services/integrations/googleCalendarDirectory.service.js";
import {
  buildJobberAuthorizationUrl,
  disconnectJobber,
  exchangeJobberAuthorizationCode,
} from "../services/integrations/jobberOAuth.service.js";
import {
  getGoogleSettings,
  getJobberSettings,
  saveGoogleSettings,
  saveJobberSettings,
} from "../services/integrations/integrationSettings.service.js";

const publicStatus = (connection) =>
  connection
    ? {
        provider: connection.provider,
        status: connection.status,
        scopes: connection.scopes,
        providerAccountId: connection.providerAccountId,
        providerCalendarId: connection.providerCalendarId,
        apiVersion: connection.apiVersion,
        metadata: connection.metadata,
        lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
        lastErrorAt: connection.lastErrorAt,
        lastErrorMessage: connection.lastErrorMessage,
        updatedAt: connection.updatedAt,
      }
    : { status: "disconnected" };

const statusWithSettings = (connection, provider) => {
  const status = publicStatus(connection);

  if (
    provider === "google_calendar" &&
    connection?.metadata?.googleCalendar
  ) {
    status.settings = getGoogleSettings(connection);
  }

  if (provider === "jobber" && connection?.metadata?.jobber) {
    status.settings = getJobberSettings(connection);
  }

  return status;
};

const ownedBusiness = (req, location = "query") =>
  getOwnedBusiness({
    user: req.user,
    requestedBusinessId: req[location]?.businessId,
  });

class IntegrationController {
  static async googleConnect(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const authorizationUrl = await buildGoogleAuthorizationUrl(business._id);
      return res.status(200).json({ success: true, data: { authorizationUrl } });
    } catch (error) {
      return next(error);
    }
  }

  static async googleCallback(req, res) {
    const frontendUrl = String(
      process.env.FRONTEND_URL || "http://localhost:3001",
    ).replace(/\/$/, "");
    try {
      if (!req.query.code || !req.query.state) {
        throw new Error("Google did not return an authorization code and state.");
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
      const business = await ownedBusiness(req);
      const connection = await getGoogleConnection(business._id);
      return res.status(200).json({
        success: true,
        data: {
          ...statusWithSettings(connection, "google_calendar"),
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  static async googleCalendars(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const useDirectory =
        String(req.query.directory || "").toLowerCase() === "true";
      const calendars = useDirectory
        ? await listGoogleCalendarDirectory(business._id)
        : await listGoogleCalendars(business._id);
      return res.status(200).json({ success: true, data: calendars });
    } catch (error) {
      return next(error);
    }
  }

  static async googleSaveSettings(req, res, next) {
    try {
      const business = await ownedBusiness(req, "body");
      const connection = await saveGoogleSettings({
        businessId: business._id,
        settings: req.body.settings || req.body,
      });
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
          settings: getGoogleSettings(connection),
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  // Backward-compatible endpoint used by the existing UI.
  static async googleSelectCalendar(req, res, next) {
    try {
      const business = await ownedBusiness(req, "body");
      const connection = await selectGoogleCalendar({
        businessId: business._id,
        calendarId: req.body.calendarId,
      });
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
        data: publicStatus(connection),
      });
    } catch (error) {
      return next(error);
    }
  }

  static async googleSync(req, res, next) {
    try {
      const business = await ownedBusiness(req, "body");
      const { syncGoogleCalendar } = await import(
        "../services/integrations/googleCalendarSync.service.js"
      );
      const result = await syncGoogleCalendar({
        businessId: business._id,
        forceFull: req.body.forceFull === true,
      });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  }

  static async googleStartWatch(req, res, next) {
    try {
      const business = await ownedBusiness(req, "body");
      const { startGoogleCalendarWatch } = await import(
        "../services/integrations/googleCalendarSync.service.js"
      );
      const connection = await startGoogleCalendarWatch(business._id);
      return res.status(200).json({
        success: true,
        data: {
          ...publicStatus(connection),
          settings: getGoogleSettings(connection),
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  static async googleStopWatch(req, res, next) {
    try {
      const business = await ownedBusiness(req, "body");
      const { stopGoogleCalendarWatch } = await import(
        "../services/integrations/googleCalendarSync.service.js"
      );
      const connection = await stopGoogleCalendarWatch(business._id);
      return res.status(200).json({
        success: true,
        data: {
          ...publicStatus(connection),
          settings: getGoogleSettings(connection),
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  static async googleDisconnect(req, res, next) {
    try {
      const business = await ownedBusiness(req, "body");
      let existingConnection = null;
      try {
        existingConnection = await getGoogleConnection(business._id);
      } catch {
        existingConnection = null;
      }
      const channel = getGoogleSettings(existingConnection).channel;
      if (channel?.id) {
        const { stopGoogleCalendarWatch } = await import(
          "../services/integrations/googleCalendarSync.service.js"
        );
        await stopGoogleCalendarWatch(business._id).catch(() => null);
      }
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
      return res.status(200).json({ success: true, data: publicStatus(connection) });
    } catch (error) {
      return next(error);
    }
  }

  static async googleTest(req, res, next) {
    try {
      const business = await ownedBusiness(req, "body");
      const result = await new GoogleCalendarProvider({ business }).testConnection();
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  }

  static async jobberConnect(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const authorizationUrl = await buildJobberAuthorizationUrl(business._id);
      return res.status(200).json({ success: true, data: { authorizationUrl } });
    } catch (error) {
      return next(error);
    }
  }

  static async jobberCallback(req, res) {
    const frontendUrl = String(
      process.env.FRONTEND_URL || "http://localhost:3001",
    ).replace(/\/$/, "");
    try {
      if (!req.query.code || !req.query.state) {
        throw new Error("Jobber did not return an authorization code and state.");
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

  static async jobberStatus(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const connection = await IntegrationConnection.findOne({
        business: business._id,
        provider: "jobber",
      });
      return res.status(200).json({
        success: true,
        data: {
          ...statusWithSettings(connection, "jobber"),
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  static async jobberSaveSettings(req, res, next) {
    try {
      const business = await ownedBusiness(req, "body");
      const connection = await saveJobberSettings({
        businessId: business._id,
        settings: req.body.settings || req.body,
      });
      return res.status(200).json({
        success: true,
        data: {
          ...publicStatus(connection),
          settings: getJobberSettings(connection),
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  static async jobberSyncLead(req, res, next) {
    try {
      const business = await ownedBusiness(req, "body");
      const { syncLeadToJobber } = await import(
        "../services/integrations/jobberWorkflow.service.js"
      );
      const result = await syncLeadToJobber({
        businessId: business._id,
        leadId: req.params.leadId,
      });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  }

  static async jobberSyncPending(req, res, next) {
    try {
      const business = await ownedBusiness(req, "body");
      const { syncPendingQualifiedLeadsToJobber } = await import(
        "../services/integrations/jobberWorkflow.service.js"
      );
      const result = await syncPendingQualifiedLeadsToJobber({
        businessId: business._id,
        limit: req.body.limit,
      });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  }

  static async jobberDisconnect(req, res, next) {
    try {
      const business = await ownedBusiness(req, "body");
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
      return res.status(200).json({ success: true, data: publicStatus(connection) });
    } catch (error) {
      return next(error);
    }
  }

  static async jobberTest(req, res, next) {
    try {
      const business = await ownedBusiness(req, "body");
      const result = await new JobberProvider({ business }).testConnection();
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  }
}

export default IntegrationController;
