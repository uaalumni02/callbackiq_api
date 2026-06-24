import Db from "../db/db.js";
import Business from "../models/business.js";
import Subscription from "../models/subscription.js";
import * as Response from "../helpers/response/response.js";

const checkSubscription = async (req, res, next) => {
  try {
    const ownerId = req.user?.userId;

    if (!ownerId) {
      return Response.responseBadAuth(res, "Not authenticated");
    }

    const business = await Db.getBusinessByOwner(Business, ownerId);

    if (!business) {
      return Response.responseInvalidInput(
        res,
        "Business not found. Create a business before using this feature.",
      );
    }

    const subscription = await Db.getSubscriptionByBusiness(
      Subscription,
      business._id,
    );

    if (!subscription) {
      return res.status(403).json({
        success: false,
        message: "Active subscription or free trial required",
      });
    }

    const now = new Date();

    const trialExpired =
      subscription.status === "trialing" &&
      subscription.trialEndsAt &&
      subscription.trialEndsAt <= now;

    if (trialExpired) {
      subscription.status = "expired";
      subscription.isActive = false;
      subscription.aiEnabled = false;
      await subscription.save();

      business.isActive = false;
      await business.save();

      return res.status(403).json({
        success: false,
        message: "Your 14-day free trial has expired",
        data: {
          status: subscription.status,
          plan: subscription.plan,
          trialEndsAt: subscription.trialEndsAt,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        },
      });
    }

    const hasActiveSubscription = subscription.status === "active";
    const hasActiveTrial =
      subscription.status === "trialing" &&
      subscription.trialEndsAt &&
      subscription.trialEndsAt > now;

    if (!hasActiveSubscription && !hasActiveTrial) {
      return res.status(403).json({
        success: false,
        message: "Your subscription is not active",
        data: {
          status: subscription.status,
          plan: subscription.plan,
          trialEndsAt: subscription.trialEndsAt,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        },
      });
    }

    if (business.isActive === false || subscription.isActive === false) {
      return res.status(403).json({
        success: false,
        message: "Your account is not active",
        data: {
          status: subscription.status,
          plan: subscription.plan,
          trialEndsAt: subscription.trialEndsAt,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        },
      });
    }

    req.business = business;
    req.subscription = subscription;

    next();
  } catch (error) {
    console.error("Error in checkSubscription:", error);
    return Response.responseServerError(res);
  }
};

export default checkSubscription;
