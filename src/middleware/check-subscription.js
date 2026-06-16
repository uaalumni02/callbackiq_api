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
        message: "Active subscription required",
      });
    }

    if (subscription.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "Your subscription is not active",
        data: {
          status: subscription.status,
          plan: subscription.plan,
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
