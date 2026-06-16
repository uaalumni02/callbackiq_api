import Db from "../db/db.js";
import Business from "../models/business.js";
import Lead from "../models/lead.js";
import CallLog from "../models/callLog.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import * as Response from "../helpers/response/response.js";

class DashboardController {
  static async getDashboardMetrics(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const metrics = await Db.getDashboardMetrics({
        Business,
        Lead,
        CallLog,
        Conversation,
        Message,
        ownerId,
      });

      if (!metrics) {
        return Response.responseInvalidInput(
          res,
          "Business not found. Create a business before viewing dashboard metrics.",
        );
      }

      return Response.responseOk(
        res,
        metrics,
        "Dashboard metrics fetched successfully",
      );
    } catch (error) {
      console.error("Error in getDashboardMetrics:", error);
      return Response.responseServerError(res);
    }
  }
}

export default DashboardController;
