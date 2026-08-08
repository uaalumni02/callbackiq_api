import Business from "../models/business.js";
import { buildBusinessReadiness } from "../services/businessReadiness.service.js";
import {
  activateTrackingNumber,
  provisionTrackingNumber,
  verifyTrackingNumber,
} from "../services/trackingNumberProvisioning.service.js";

const getOwnedBusiness = async (req) => {
  const ownerId = req.user?.userId;
  if (!ownerId) return null;
  return Business.findOne({ owner: ownerId }).select("+trackingNumber.providerSid");
};

const errorResponse = (res, error) =>
  res.status(error?.statusCode || 500).json({
    success: false,
    code: error?.code || "BUSINESS_SETUP_FAILED",
    message: error?.message || "Unable to update CallBackIQ setup.",
    ...(error?.readiness ? { readiness: error.readiness } : {}),
  });

class BusinessSetupController {
  static async readiness(req, res) {
    try {
      const business = await getOwnedBusiness(req);
      if (!business) return res.status(404).json({ success: false, message: "Business not found" });
      const readiness = await buildBusinessReadiness(business, { persist: true });
      return res.status(200).json({ success: true, data: readiness });
    } catch (error) {
      return errorResponse(res, error);
    }
  }

  static async trackingNumber(req, res) {
    try {
      const business = await getOwnedBusiness(req);
      if (!business) return res.status(404).json({ success: false, message: "Business not found" });
      const readiness = await buildBusinessReadiness(business, { persist: false });
      return res.status(200).json({ success: true, data: readiness.trackingNumber });
    } catch (error) {
      return errorResponse(res, error);
    }
  }

  static async provision(req, res) {
    try {
      const business = await getOwnedBusiness(req);
      if (!business) return res.status(404).json({ success: false, message: "Business not found" });
      const updated = await provisionTrackingNumber(business);
      const readiness = await buildBusinessReadiness(updated, { persist: true });
      return res.status(200).json({
        success: true,
        message: "CallBackIQ number assigned, verified, and activated.",
        data: readiness,
      });
    } catch (error) {
      return errorResponse(res, error);
    }
  }

  static async verify(req, res) {
    try {
      const business = await getOwnedBusiness(req);
      if (!business) return res.status(404).json({ success: false, message: "Business not found" });
      const updated = await verifyTrackingNumber(business);
      const readiness = await buildBusinessReadiness(updated, { persist: true });
      return res.status(200).json({ success: true, message: "CallBackIQ number verified.", data: readiness });
    } catch (error) {
      return errorResponse(res, error);
    }
  }

  static async activate(req, res) {
    try {
      const business = await getOwnedBusiness(req);
      if (!business) return res.status(404).json({ success: false, message: "Business not found" });
      const updated = await activateTrackingNumber(business);
      const readiness = await buildBusinessReadiness(updated, { persist: true });
      return res.status(200).json({ success: true, message: "CallBackIQ number activated.", data: readiness });
    } catch (error) {
      return errorResponse(res, error);
    }
  }

  static async updateProgress(req, res) {
    try {
      const business = await getOwnedBusiness(req);
      if (!business) return res.status(404).json({ success: false, message: "Business not found" });
      const allowed = ["smsRecoveryTested", "inboxTested", "voiceAiTested", "bookingTested"];
      const updates = {};
      for (const field of allowed) {
        if (typeof req.body?.[field] === "boolean") updates[`setupProgress.${field}`] = req.body[field];
      }
      if (!Object.keys(updates).length) {
        return res.status(400).json({ success: false, message: "No supported setup progress fields were provided." });
      }
      updates["setupProgress.updatedAt"] = new Date();
      await Business.updateOne({ _id: business._id }, { $set: updates });
      const readiness = await buildBusinessReadiness(business._id, { persist: true });
      return res.status(200).json({ success: true, data: readiness });
    } catch (error) {
      return errorResponse(res, error);
    }
  }
}

export default BusinessSetupController;
