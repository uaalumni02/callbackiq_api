import Db from "../db/db.js";
import Business from "../models/business.js";
import Subscription from "../models/subscription.js";
import * as Response from "../helpers/response/response.js";

const ACTIVE_STATUSES = new Set(["active", "trialing"]);

const getBusinessForRequest = async (req, ownerId) => {
  if (req.business) {
    return req.business;
  }

  return typeof Db.getBusinessScopeByOwner === "function"
    ? Db.getBusinessScopeByOwner(Business, ownerId)
    : Db.getBusinessByOwner(Business, ownerId);
};

const getSubscriptionForRequest = async (req, businessId) => {
  if (req.subscription) {
    return req.subscription;
  }

  /*
   * Do not populate Business here. The business has already been loaded and
   * attached to the request, and the middleware only needs subscription data.
   */
  return Subscription.findOne({
    business: businessId,
  });
};

const checkSubscription = async (req, res, next) => {
  try {
    const ownerId = req.user?.userId;

    if (!ownerId) {
      return Response.responseBadAuth(res, "Not authenticated");
    }

    const business = await getBusinessForRequest(req, ownerId);

    if (!business) {
      return Response.responseInvalidInput(res, "Business not found");
    }

    req.business = business;

    let subscription = await getSubscriptionForRequest(req, business._id);

    if (!subscription) {
      return res.status(403).json({
        success: false,
        message: "Active subscription required",
      });
    }

    const now = new Date();

    const trialExpired =
      subscription.status === "trialing" &&
      subscription.trialEndsAt &&
      new Date(subscription.trialEndsAt) <= now;

    if (trialExpired) {
      const [updatedSubscription, updatedBusiness] = await Promise.all([
        Subscription.findByIdAndUpdate(
          subscription._id,
          {
            $set: {
              status: "expired",
              isActive: false,
              aiEnabled: false,
            },
          },
          {
            new: true,
            runValidators: true,
          },
        ),

        Business.findByIdAndUpdate(
          business._id,
          {
            $set: {
              isActive: false,
            },
          },
          {
            new: true,
            runValidators: true,
          },
        ).select(
          "_id owner businessName businessType phone forwardingPhone email website address city state zipCode timezone smsTemplate estimatedJobValue isActive createdAt updatedAt",
        ),
      ]);

      subscription = updatedSubscription || subscription;
      subscription.status = "expired";
      subscription.isActive = false;
      subscription.aiEnabled = false;

      const inactiveBusiness = updatedBusiness || business;

      inactiveBusiness.isActive = false;

      req.subscription = subscription;
      req.business = inactiveBusiness;

      return res.status(403).json({
        success: false,
        message:
          "Your free trial has expired. Please activate your subscription.",
        data: {
          status: subscription.status,
          subscriptionIsActive: subscription.isActive,
          businessIsActive: inactiveBusiness.isActive,
          plan: subscription.plan,
          aiEnabled: subscription.aiEnabled,
        },
      });
    }

    const hasActiveStatus = ACTIVE_STATUSES.has(subscription.status);
    const businessActive = business.isActive === true;

    if (!hasActiveStatus || !businessActive) {
      req.subscription = subscription;

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

    /*
     * Preserve the existing self-healing behavior, but perform one atomic
     * update only when these flags are out of sync with an active status.
     */
    if (subscription.isActive !== true || subscription.aiEnabled !== true) {
      const normalizedSubscription = await Subscription.findByIdAndUpdate(
        subscription._id,
        {
          $set: {
            isActive: true,
            aiEnabled: true,
          },
        },
        {
          new: true,
          runValidators: true,
        },
      );

      if (normalizedSubscription) {
        subscription = normalizedSubscription;
      } else {
        subscription.isActive = true;
        subscription.aiEnabled = true;
      }
    }

    req.subscription = subscription;

    return next();
  } catch (error) {
    console.error("Error in checkSubscription:", error);
    return Response.responseServerError(res);
  }
};

export default checkSubscription;
