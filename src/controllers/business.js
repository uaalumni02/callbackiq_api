import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import businessValidator from "../validator/business.js";
import * as Response from "../helpers/response/response.js";

class BusinessController {
  static async createBusiness(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      await businessValidator.validateAsync(req.body);

      const existingBusiness = await Db.getBusinessByOwner(Business, ownerId);

      if (existingBusiness) {
        return Response.responseConflict(
          res,
          "You already have a business account",
        );
      }

      const business = await Db.saveBusiness(Business, {
        ...req.body,
        owner: ownerId,
      });

      return res.status(201).json({
        success: true,
        message: "Business created successfully",
        data: business,
      });
    } catch (error) {
      console.error("Error in createBusiness:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

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
      const { id } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid business ID");
      }

      const business = await Db.getBusinessById(Business, id);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      return Response.responseOk(res, business, "Business fetched");
    } catch (error) {
      console.error("Error in getBusinessById:", error);
      return Response.responseServerError(res);
    }
  }

  static async getAllBusinesses(req, res) {
    try {
      const businesses = await Db.getAllBusinesses(Business);

      return Response.responseOk(res, businesses, "Businesses fetched");
    } catch (error) {
      console.error("Error in getAllBusinesses:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateMyBusiness(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      await businessValidator.validateAsync(req.body);

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const updatedBusiness = await Db.updateBusiness(
        Business,
        business._id,
        req.body,
      );

      return Response.responseOk(
        res,
        updatedBusiness,
        "Business updated successfully",
      );
    } catch (error) {
      console.error("Error in updateMyBusiness:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      return Response.responseServerError(res);
    }
  }

  static async deleteMyBusiness(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      await Db.deleteBusiness(Business, business._id);

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
