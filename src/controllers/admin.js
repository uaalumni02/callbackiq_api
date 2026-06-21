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

      await Db.createAdminActionLog(AdminActionLog, {
        admin: req.user.userId,
        action: "view_dashboard",
        message: "Admin dashboard viewed",
      });

      return Response.responseOk(
        res,
        data,
        "Admin dashboard fetched successfully",
      );
    } catch (error) {
      console.error("Admin dashboard error:", error);
      return Response.responseServerError(res);
    }
  }

  static async getCustomerDetails(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      await adminBusinessIdSchema.validateAsync(req.params);

      const data = await Db.getAdminCustomerDetails({
        User,
        Business,
        Lead,
        CallLog,
        Conversation,
        Message,
        Subscription,
        businessId: req.params.businessId,
      });

      if (!data) {
        return Response.responseInvalidInput(
          res,
          "Customer business not found",
        );
      }

      await Db.createAdminActionLog(AdminActionLog, {
        admin: req.user.userId,
        targetBusiness: req.params.businessId,
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

      console.error("Admin customer details error:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateSubscriptionStatus(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      await adminBusinessIdSchema.validateAsync(req.params);
      await adminSubscriptionStatusSchema.validateAsync(req.body);

      const subscription = await Db.adminUpdateSubscriptionStatus({
        Subscription,
        businessId: req.params.businessId,
        status: req.body.status,
      });

      await Db.createAdminActionLog(AdminActionLog, {
        admin: req.user.userId,
        targetBusiness: req.params.businessId,
        action: "update_subscription_status",
        message: `Subscription status updated to ${req.body.status}`,
        metadata: { status: req.body.status },
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

      console.error("Admin subscription update error:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateBusinessStatus(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      await adminBusinessIdSchema.validateAsync(req.params);
      await adminBusinessStatusSchema.validateAsync(req.body);

      const business = await Db.adminUpdateBusinessStatus({
        Business,
        businessId: req.params.businessId,
        isActive: req.body.isActive,
      });

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      await Db.createAdminActionLog(AdminActionLog, {
        admin: req.user.userId,
        targetBusiness: req.params.businessId,
        action: "update_business_status",
        message: `Business active status updated to ${req.body.isActive}`,
        metadata: { isActive: req.body.isActive },
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

      console.error("Admin business update error:", error);
      return Response.responseServerError(res);
    }
  }
}

export default AdminController;
