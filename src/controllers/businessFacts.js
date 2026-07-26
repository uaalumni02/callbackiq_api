import Business from "../models/business.js";
import Db from "../db/db.js";
import * as Response from "../helpers/response/response.js";
import { businessFactsUpdateSchema } from "../validator/businessFacts.js";
import {
  buildVerifiedFactUpdate,
  getBusinessFactsReadiness,
  getOwnerSafeBusinessFacts,
} from "../services/businessFacts.service.js";

const getOwnerBusiness = async (ownerId) => {
  if (typeof Db.getBusinessScopeByOwner === "function") {
    return Db.getBusinessScopeByOwner(Business, ownerId);
  }

  return Db.getBusinessByOwner(Business, ownerId);
};

class BusinessFactsController {
  static async getMine(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await getOwnerBusiness(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      return Response.responseOk(
        res,
        {
          facts: getOwnerSafeBusinessFacts(business),
          capabilities: business.aiCapabilities || {},
          readiness: getBusinessFactsReadiness(business),
          lastReviewedAt: business.aiKnowledge?.lastReviewedAt || null,
        },
        "Verified business facts fetched successfully",
      );
    } catch (error) {
      console.error("Error fetching business facts:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateMine(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const validated = await businessFactsUpdateSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      const business = await getOwnerBusiness(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const update = buildVerifiedFactUpdate({
        facts: validated.facts,
        actorId: ownerId,
      });

      if (validated.capabilities) {
        for (const [key, value] of Object.entries(validated.capabilities)) {
          update[`aiCapabilities.${key}`] = value;
        }
      }

      const updatedBusiness = await Business.findOneAndUpdate(
        {
          _id: business._id,
          owner: ownerId,
        },
        {
          $set: update,
        },
        {
          returnDocument: "after",
          runValidators: true,
        },
      );

      return Response.responseOk(
        res,
        {
          facts: getOwnerSafeBusinessFacts(updatedBusiness),
          capabilities: updatedBusiness.aiCapabilities || {},
          readiness: getBusinessFactsReadiness(updatedBusiness),
          lastReviewedAt:
            updatedBusiness.aiKnowledge?.lastReviewedAt || null,
        },
        "Verified business facts updated successfully",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error updating business facts:", error);
      return Response.responseServerError(res);
    }
  }
}

export default BusinessFactsController;
