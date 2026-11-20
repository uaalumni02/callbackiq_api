import "../../models/trialRedemption.js";
import Business from "../../models/business.js";
import * as Response from "../../helpers/response/response.js";
import Subscription from "../../models/subscription.js";
import { extendTrialByAdmin } from "../../services/trialLifecycle.service.js";
import { isAccessStatus } from "./helpers.js";
import { safeConsole } from "../../helpers/logging/safeLogger.js";

export default class BillingAdministrationController {
static async adminGrantTrialOverride(req, res) {
    try {
      const { businessId } = req.params;
      const { days = 7, reason = "" } = req.body || {};
      const subscription = await extendTrialByAdmin({
        businessId,
        adminUserId: req.user.userId,
        operationKey: req.get?.("Idempotency-Key") || req.body?.operationKey || "",
        days,
        reason,
      });

      return Response.responseOk(
        res,
        subscription,
        "Active trial extended without changing the lifetime trial identity lock",
      );
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code,
          message: error.message,
        });
      }
      safeConsole.error("Error in adminGrantTrialOverride:", error);
      return Response.responseServerError(res);
    }
  }

static async updateAdminCustomerAccountStatus(req, res) {
    try {
      const { businessId } = req.params;
      const { isActive } = req.body;

      if (typeof isActive !== "boolean") {
        return Response.responseInvalidInput(
          res,
          "isActive must be true or false",
        );
      }

      const [business, existingSubscription] = await Promise.all([
        Business.findById(businessId),
        Subscription.findOne({ business: businessId }).select(
          "_id business status",
        ),
      ]);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const nextStatus = isActive
        ? isAccessStatus(existingSubscription?.status)
          ? existingSubscription.status
          : "active"
        : "canceled";

      const [updatedBusiness] = await Promise.all([
        Business.findByIdAndUpdate(
          businessId,
          { $set: { isActive } },
          {
            returnDocument: "after",
            runValidators: true,
          },
        ),
        Subscription.findOneAndUpdate(
          { business: businessId },
          {
            $set: {
              isActive,
              aiEnabled: isActive,
              status: nextStatus,
              lastPaymentStatus: isActive ? nextStatus : "admin_deactivated",
            },
          },
          {
            returnDocument: "after",
            runValidators: true,
          },
        ),
      ]);

      const responseBusiness = updatedBusiness || business;

      return Response.responseOk(
        res,
        responseBusiness,
        isActive
          ? "Customer account activated successfully"
          : "Customer account deactivated successfully",
      );
    } catch (error) {
      safeConsole.error("Error in updateAdminCustomerAccountStatus:", error);
      return Response.responseServerError(res);
    }
  }
}
