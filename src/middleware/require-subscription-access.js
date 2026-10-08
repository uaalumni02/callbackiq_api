import { safeConsole } from "../helpers/logging/safeLogger.js";
import Subscription from "../models/subscription.js";
import Business from "../models/business.js";
import Db from "../db/db.js";
import {
  ACCESS_LEVELS,
  getSubscriptionAccess,
} from "../services/subscriptionAccess.service.js";

const getBusiness = async (req) => {
  if (req.business) {
    return req.business;
  }

  const ownerId = req.user?.userId;

  if (!ownerId) {
    return null;
  }

  if (typeof Db.getBusinessScopeByOwner === "function") {
    return Db.getBusinessScopeByOwner(Business, ownerId);
  }

  return Db.getBusinessByOwner(Business, ownerId);
};

const getDeniedMessage = ({ minimumLevel, subscription }) => {
  if (minimumLevel !== ACCESS_LEVELS.FULL) {
    return "Subscription access is unavailable";
  }

  /*
   * Preserve the existing API distinction:
   *
   * No subscription record:
   * "Active subscription required"
   *
   * Existing but inactive subscription:
   * "Your subscription is not active"
   */
  return subscription
    ? "Your subscription is not active"
    : "Active subscription required";
};

const requireSubscriptionAccess =
  (minimumLevel = ACCESS_LEVELS.FULL) =>
  async (req, res, next) => {
    try {
      const business = await getBusiness(req);

      if (!business) {
        return res.status(400).json({
          success: false,
          message: "Business not found",
        });
      }

      const subscription =
        req.subscription ||
        (await Db.getSubscriptionByBusiness(Subscription, business._id, { populateBusiness: false }));

      const access = getSubscriptionAccess(subscription);

      req.business = business;
      req.subscription = subscription;
      req.subscriptionAccess = access;

      const allowed =
        minimumLevel === ACCESS_LEVELS.READ_ONLY
          ? [ACCESS_LEVELS.READ_ONLY, ACCESS_LEVELS.FULL].includes(access.level)
          : minimumLevel === ACCESS_LEVELS.BILLING_ONLY
            ? access.level !== ACCESS_LEVELS.BLOCKED
            : access.level === ACCESS_LEVELS.FULL;

      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: getDeniedMessage({
            minimumLevel,
            subscription,
          }),
          data: access,
        });
      }

      return next();
    } catch (error) {
      safeConsole.error("Subscription access middleware error:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to verify subscription access",
      });
    }
  };

export default requireSubscriptionAccess;
