import { getBusinessFeatures } from '../helpers/businessFeatures.js';
import { safeConsole } from "../helpers/logging/safeLogger.js";

import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import User from "../models/user.js";
import { normalizePhoneToE164 as normalizeBusinessPhone } from "../voice/voicePhone.service.js";
import { FORWARDING_PHONE_CONFLICT, forwardingPhoneConflictQuery, isForwardingPhoneDuplicate } from "../helpers/forwardingPhonePolicy.js";
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

const buildBusinessCreationPayload = (payload, ownerId, forwardingPhone) => {
  const businessPayload = {
    ...payload,
    forwardingPhone,
    owner: ownerId,
    trackingNumber: {
      provider: "twilio",
      status: "unassigned",
    },
    setupProgress: {
      accountRegistered: true, suggestedServicesPending: true,
      forwardingPhoneConfigured: Boolean(forwardingPhone),
      updatedAt: new Date(),
    },
  };
  // phone is a legacy create alias only. Never persist the owner's
  // existing business number as the MeekCall tracking number.
  delete businessPayload.phone;
  return businessPayload;
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
        return res.status(409).json({
          success: false,
          code: "BUSINESS_ALREADY_EXISTS",
          message: "Your business account is already saved. Resume setup to continue.",
          recovery: { action: "resume_setup", path: "/setup" },
        });
      }

      const forwardingPhone = String(
        payload.forwardingPhone || payload.phone || "",
      ).trim();
      if (!normalizeBusinessPhone(forwardingPhone)) {
        return Response.responseInvalidInput(res, "Please enter a valid forwarding phone number");
      }
      if (await Business.exists(forwardingPhoneConflictQuery(forwardingPhone))) {
        return res.status(409).json(FORWARDING_PHONE_CONFLICT);
      }
      const businessPayload = buildBusinessCreationPayload(payload, ownerId, forwardingPhone);

      const business = await Db.saveBusiness(Business, businessPayload);

      return res.status(201).json({
        success: true,
        message: "Business created successfully",
        data: business,
      });
    } catch (error) {
      if (isForwardingPhoneDuplicate(error)) {
        return res.status(409).json(FORWARDING_PHONE_CONFLICT);
      }
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      safeConsole.error("Error in createBusiness:", error);
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

      return Response.responseOk(res, { ...(business.toObject?.() || business), features: getBusinessFeatures(business) }, "Business fetched");
    } catch (error) {
      safeConsole.error("Error in getMyBusiness:", error);
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

      return Response.responseOk(res, { ...(business.toObject?.() || business), features: getBusinessFeatures(business) }, "Business fetched");
    } catch (error) {
      safeConsole.error("Error in getBusinessById:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateMyBusiness(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const currentBusiness = await Db.getBusinessByOwner(Business, ownerId);
      if (!currentBusiness) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const payload = await businessUpdateSchema.validateAsync(req.body, {
        abortEarly: false, context: { currentBusinessType: currentBusiness.businessType },
        stripUnknown: false,
      });

      if (payload.forwardingPhone) {
        const rawForwardingPhone = String(payload.forwardingPhone).trim();
        const normalizedForwardingPhone = normalizeBusinessPhone(rawForwardingPhone);
        if (!normalizedForwardingPhone) {
          return Response.responseInvalidInput(
            res,
            "Please enter a valid forwarding phone number",
          );
        }
        const duplicateForwardingPhone = currentBusiness.isActive !== false &&
          await Business.exists(forwardingPhoneConflictQuery(rawForwardingPhone, currentBusiness._id));
        if (duplicateForwardingPhone) {
          return res.status(409).json(FORWARDING_PHONE_CONFLICT);
        }
        payload.forwardingPhone = normalizedForwardingPhone;
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
      if (payload.businessType === currentBusiness.businessType) delete updates.businessType;
      if (Object.prototype.hasOwnProperty.call(payload, "forwardingPhone")) {
        const previousForwardingPhone = normalizeBusinessPhone(
          currentBusiness.forwardingPhone || "",
        );
        const nextForwardingPhone = normalizeBusinessPhone(
          payload.forwardingPhone || "",
        );
        updates["setupProgress.forwardingPhoneConfigured"] = Boolean(
          String(payload.forwardingPhone || "").trim(),
        );
        updates["setupProgress.updatedAt"] = new Date();

        if (previousForwardingPhone !== nextForwardingPhone) {
          updates.forwardingPhoneVerifiedAt = null;
          updates.forwardingPhoneVerifiedValue = "";
        }
      }

      const updatedBusiness = await Db.updateBusinessByOwner(
        Business,
        ownerId,
        updates,
      );

      if (!updatedBusiness) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const ownerUpdates = {};
      if (Object.prototype.hasOwnProperty.call(payload, "businessName")) {
        ownerUpdates.businessName = updatedBusiness.businessName;
      }
      if (payload.businessType && payload.businessType !== currentBusiness.businessType) {
        ownerUpdates.businessType = updatedBusiness.businessType;
      }
      if (Object.prototype.hasOwnProperty.call(payload, "forwardingPhone")) {
        ownerUpdates.businessPhone = updatedBusiness.forwardingPhone || "";
      }
      if (Object.keys(ownerUpdates).length > 0) {
        await User.findByIdAndUpdate(
          ownerId,
          { $set: ownerUpdates },
          { runValidators: true },
        );
      }

      req.business = updatedBusiness;

      return Response.responseOk(
        res,
        updatedBusiness,
        "Business updated successfully",
      );
    } catch (error) {
      if (isForwardingPhoneDuplicate(error)) {
        return res.status(409).json(FORWARDING_PHONE_CONFLICT);
      }
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }
      if (error.code === "BOOKING_NOT_READY") {
        return res.status(error.statusCode || 409).json({
          success: false,
          code: error.code,
          message: error.message,
          readiness: error.readiness,
        });
      }

      safeConsole.error("Error in updateMyBusiness:", error);
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
      safeConsole.error("Error in deleteMyBusiness:", error);
      return Response.responseServerError(res);
    }
  }
}

export default BusinessController;
