




import Db from "../../db/db.js";
import Business from "../../models/business.js";
import Subscription from "../../models/subscription.js";
import "../../models/trialRedemption.js";













const getClientUrl = () => {
  return process.env.CLIENT_URL || "http://localhost:3001";
};

const isAccessStatus = (status) => {
  return ["trialing", "active"].includes(status);
};

const getRequestBusiness = async (req, ownerId) => {
  if (req.business) {
    return req.business;
  }

  const business = await Db.getBusinessByOwner(Business, ownerId);

  if (business) {
    req.business = business;
  }

  return business;
};

const getRequestSubscription = async (req, businessId) => {
  if (
    req.subscription &&
    String(req.subscription.business?._id || req.subscription.business) ===
      String(businessId)
  ) {
    return req.subscription;
  }

  /*
   * Query the model directly so this controller remains compatible with both
   * the original and optimized Db helper versions. A full Mongoose document
   * is required because trial-expiration logic may update the subscription.
   */
  const subscription = await Subscription.findOne({
    business: businessId,
  });

  if (subscription) {
    req.subscription = subscription;
  }

  return subscription;
};

export { getRequestBusiness, getRequestSubscription, isAccessStatus, getClientUrl };
