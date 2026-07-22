import Db from "../db/db.js";
import Business from "../models/business.js";
import * as Response from "../helpers/response/response.js";

const checkActiveBusiness = async (req, res, next) => {
  try {
    const ownerId = req.user?.userId;
    const role = String(req.user?.role || "")
      .trim()
      .toLowerCase();

    if (!ownerId) {
      return Response.responseBadAuth(res, "Not authenticated");
    }

    if (role === "admin") {
      return next();
    }

    /*
     * Reuse a business already loaded by checkSubscription. This prevents two
     * identical business queries when both middleware functions protect a
     * route. If it has not been loaded, use the lightweight tenant lookup.
     */
    const business =
      req.business ||
      (await (typeof Db.getBusinessScopeByOwner === "function"
        ? Db.getBusinessScopeByOwner(Business, ownerId)
        : Db.getBusinessByOwner(Business, ownerId)));

    if (!business) {
      return Response.responseInvalidInput(
        res,
        "Business not found. Create a business before using this feature.",
      );
    }

    if (business.isActive === false) {
      return res.status(403).json({
        success: false,
        message:
          "This account is inactive. Please contact support to restore access.",
        data: {
          businessId: business._id,
          businessName: business.businessName,
          isActive: false,
        },
      });
    }

    req.business = business;

    return next();
  } catch (error) {
    console.error("Error in checkActiveBusiness:", error);
    return Response.responseServerError(res);
  }
};

export default checkActiveBusiness;
