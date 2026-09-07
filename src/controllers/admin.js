import { safeConsole } from "../helpers/logging/safeLogger.js";
import Db from "../db/db.js";
import Business from "../models/business.js";
import AdminActionLog from "../models/adminActionLog.js";

import {
  adminBusinessIdSchema,
  adminSubscriptionStatusSchema,
  adminBusinessStatusSchema,
} from "../validator/admin.js";

import { isAdminUser } from "../helpers/model/admin.js";
import * as Response from "../helpers/response/response.js";

const createAdminLog = async (req, payload) => {
  return Db.createAdminActionLog(AdminActionLog, {
    admin: req.user.userId,
    ...payload,
  });
};

class AdminController {
  static async updateSubscriptionStatus(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      await Promise.all([
        adminBusinessIdSchema.validateAsync(req.params),
        adminSubscriptionStatusSchema.validateAsync(req.body),
      ]);

      return res.status(410).json({
        success: false,
        code: "DIRECT_SUBSCRIPTION_MUTATION_RETIRED",
        message: "Direct billing-status edits are retired. Use Stripe billing actions; account access remains available through account-status.",
      });
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      safeConsole.error("Admin subscription update error:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateBusinessStatus(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const [{ businessId }, { isActive }] = await Promise.all([
        adminBusinessIdSchema.validateAsync(req.params),
        adminBusinessStatusSchema.validateAsync(req.body),
      ]);

      const business = await Db.adminUpdateBusinessStatus({
        Business,
        businessId,
        isActive,
      });

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      await createAdminLog(req, {
        targetBusiness: businessId,
        action: "update_business_status",
        message: `Business active status updated to ${isActive}`,
        metadata: { isActive },
      });

      return Response.responseOk(
        res,
        business,
        "Business status updated successfully",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      safeConsole.error("Admin business update error:", error);
      return Response.responseServerError(res);
    }
  }
}

export default AdminController;
