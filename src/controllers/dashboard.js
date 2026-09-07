import { safeConsole } from "../helpers/logging/safeLogger.js";
// CALLBACKIQ_SCALE_HARDENING_V1
import Db from "../db/db.js";
import Business from "../models/business.js";
import Lead from "../models/lead.js";
import CallLog from "../models/callLog.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import * as Response from "../helpers/response/response.js";
import ScaleCache from "../services/scaleCache.service.js";

const cacheNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

class DashboardController {
  static async getDashboardMetrics(req, res) {
    try {
      const ownerId = req.user?.userId;
      const businessId = req.params?.businessId || req.query?.businessId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const metrics = await ScaleCache.getOrLoad({
        key: `legacy-dashboard:${ownerId}:${businessId || "mine"}`,
        ttlMs: cacheNumber("DASHBOARD_CACHE_TTL_MS", 5000),
        staleMs: cacheNumber("DASHBOARD_CACHE_STALE_MS", 20000),
        loader: () =>
          Db.getDashboardMetrics({
            Business,
            Lead,
            CallLog,
            Conversation,
            Message,
            ownerId,
            businessId,
          }),
      });

      if (!metrics) {
        return Response.responseInvalidInput(
          res,
          "Business not found or you do not have access to this business.",
        );
      }

      res.setHeader(
        "Cache-Control",
        "private, max-age=2, stale-while-revalidate=10",
      );

      return Response.responseOk(
        res,
        metrics,
        "Dashboard metrics fetched successfully",
      );
    } catch (error) {
      safeConsole.error("Error in getDashboardMetrics:", error);
      return Response.responseServerError(res);
    }
  }
}

export default DashboardController;
