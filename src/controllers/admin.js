import { safeConsole } from "../helpers/logging/safeLogger.js";
import Db from "../db/db.js";
import User from "../models/user.js";
import Business from "../models/business.js";
import Lead from "../models/lead.js";
import CallLog from "../models/callLog.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import Subscription from "../models/subscription.js";
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
  static async getAdminDashboard(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const data = await Db.getAdminDashboardData({
        User,
        Business,
        Lead,
        CallLog,
        Conversation,
        Message,
        Subscription,
      });

      await createAdminLog(req, {
        action: "view_dashboard",
        message: "Admin dashboard viewed",
      });

      return Response.responseOk(
        res,
        data,
        "Admin dashboard fetched successfully",
      );
    } catch (error) {
      safeConsole.error("Admin dashboard error:", error);
      return Response.responseServerError(res);
    }
  }

  static async getCustomerDetails(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const { businessId } = await adminBusinessIdSchema.validateAsync(
        req.params,
      );

      const data = await Db.getAdminCustomerDetails({
        User,
        Business,
        Lead,
        CallLog,
        Conversation,
        Message,
        Subscription,
        businessId,
      });

      if (!data) {
        return Response.responseInvalidInput(
          res,
          "Customer business not found",
        );
      }

      await createAdminLog(req, {
        targetBusiness: businessId,
        action: "view_customer",
        message: "Admin customer detail viewed",
      });

      return Response.responseOk(
        res,
        data,
        "Customer details fetched successfully",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      safeConsole.error("Admin customer details error:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateSubscriptionStatus(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const [{ businessId }, { status }] = await Promise.all([
        adminBusinessIdSchema.validateAsync(req.params),
        adminSubscriptionStatusSchema.validateAsync(req.body),
      ]);

      const subscription = await Db.adminUpdateSubscriptionStatus({
        Subscription,
        businessId,
        status,
      });

      await createAdminLog(req, {
        targetBusiness: businessId,
        action: "update_subscription_status",
        message: `Subscription status updated to ${status}`,
        metadata: { status },
      });

      return Response.responseOk(
        res,
        subscription,
        "Subscription status updated successfully",
      );
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
