import Business from "../../models/business.js";
import GoogleCalendarProvider from "../../integrations/scheduling/googleCalendar.provider.js";
import getOwnedBusiness from "../../services/businessScope.service.js";
import { loadGoogleCalendarSyncService, publicStatus } from "./helpers.js";

export default class IntegrationGoogleOperationsController {
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
}
