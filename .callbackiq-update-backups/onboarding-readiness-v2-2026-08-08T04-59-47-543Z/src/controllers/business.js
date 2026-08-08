
import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import {
  businessCreateSchema,
  businessUpdateSchema,
} from "../validator/business.js";
import { assertBookingCanBeEnabled } from "../services/businessReadiness.service.js";
import * as Response from "../helpers/response/response.js";

const buildBusinessUpdateDocument = (payload = {}) => {
  const updates = {
    ...payload,
  };

  const featureUpdates = updates.features || null;

  delete updates.features;

  if (featureUpdates) {
    Object.entries(featureUpdates).forEach(([key, value]) => {
      updates[`features.${key}`] = value;
    });
  }

  return updates;
};

class BusinessController {
  static async createBusiness(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const payload = await businessCreateSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: false,
      });

      const existingBusiness = await Db.getBusinessScopeByOwner(
        Business,
        ownerId,
      );

      if (existingBusiness) {
        return Response.responseConflict(
          res,
          "You already have a business account",
        );
      }

      const business = await Db.saveBusiness(Business, {
        ...payload,
        owner: ownerId,
      });

      return res.status(201).json({
        success: true,
        message: "Business created successfully",
        data: business,
      });
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in createBusiness:", error);
      return Response.responseServerError(res);
    }
  }

  static async getMyBusiness(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      return Response.responseOk(res, business, "Business fetched");
    } catch (error) {
      console.error("Error in getMyBusiness:", error);
      return Response.responseServerError(res);
    }
  }

  static async getBusinessById(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid business ID");
      }

      const business = await Db.getBusinessById(Business, id);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      if (String(business.owner?._id || business.owner) !== String(ownerId)) {
        return Response.responseBadAuth(
          res,
          "Not authorized to access this business",
        );
      }

      return Response.responseOk(res, business, "Business fetched");
    } catch (error) {
      console.error("Error in getBusinessById:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateMyBusiness(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const payload = await businessUpdateSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: false,
      });

      const currentBusiness = await Db.getBusinessByOwner(Business, ownerId);
      if (!currentBusiness) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const candidateBusiness = {
        ...(currentBusiness.toObject?.() || currentBusiness),
        features: {
          ...(currentBusiness.features?.toObject?.() ||
            currentBusiness.features ||
            {}),
          ...(payload.features || {}),
        },
      };

      if (
        payload.features?.aiBookingEnabled === true &&
        currentBusiness.features?.aiBookingEnabled !== true
      ) {
        await assertBookingCanBeEnabled(candidateBusiness);
      }

      const updates = buildBusinessUpdateDocument(payload);

      const updatedBusiness = await Db.updateBusinessByOwner(
        Business,
        ownerId,
        updates,
      );

      if (!updatedBusiness) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      req.business = updatedBusiness;

      return Response.responseOk(
        res,
        updatedBusiness,
        "Business updated successfully",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in updateMyBusiness:", error);
      return Response.responseServerError(res);
    }
  }

  static async deleteMyBusiness(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const deletedBusiness = await Db.deleteBusinessByOwner(Business, ownerId);

      if (!deletedBusiness) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      return res.status(200).json({
        success: true,
        message: "Business deleted successfully",
      });
    } catch (error) {
      console.error("Error in deleteMyBusiness:", error);
      return Response.responseServerError(res);
    }
  }
}

export default BusinessController;
