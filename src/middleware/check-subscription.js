import Db from "../db/db.js";
import Business from "../models/business.js";
import Subscription from "../models/subscription.js";
import * as Response from "../helpers/response/response.js";

const ACTIVE_STATUSES = ["active", "trialing"];

const checkSubscription = async (req, res, next) => {
  try {
    const ownerId = req.user?.userId;

    if (!ownerId) {
      return Response.responseBadAuth(res, "Not authenticated");
    }

    const business = await Db.getBusinessByOwner(Business, ownerId);

    if (!business) {
      return Response.responseInvalidInput(res, "Business not found");
    }

    req.business = business;

    const subscription = await Db.getSubscriptionByBusiness(
      Subscription,
      business._id,
    );

    if (!subscription) {
      return res.status(403).json({
        success: false,
        message: "Active subscription required",
      });
    }

    const trialExpired =
      subscription.status === "trialing" &&
      subscription.trialEndsAt &&
      new Date(subscription.trialEndsAt) <= new Date();

    if (trialExpired) {
      subscription.status = "expired";
      subscription.isActive = false;
      subscription.aiEnabled = false;
      await subscription.save();

      business.isActive = false;
      await business.save();

      return res.status(403).json({
        success: false,
        message:
          "Your free trial has expired. Please activate your subscription.",
        data: {
          status: subscription.status,
          subscriptionIsActive: subscription.isActive,
          businessIsActive: business.isActive,
          plan: subscription.plan,
          aiEnabled: subscription.aiEnabled,
        },
      });
    }

    const hasActiveStatus = ACTIVE_STATUSES.includes(subscription.status);
    const businessActive = business.isActive === true;

    if (!hasActiveStatus || !businessActive) {
      return res.status(403).json({
        success: false,
        message: "Your subscription is not active",
        data: {
          status: subscription.status,
          subscriptionIsActive: subscription.isActive,
          businessIsActive: business.isActive,
          plan: subscription.plan,
          aiEnabled: subscription.aiEnabled,
        },
      });
    }

    if (subscription.isActive !== true || subscription.aiEnabled !== true) {
      subscription.isActive = true;
      subscription.aiEnabled = true;
      await subscription.save();
    }

    req.subscription = subscription;

    return next();
  } catch (error) {
    console.error("Error in checkSubscription:", error);
    return Response.responseServerError(res);
  }
};

export default checkSubscription;
