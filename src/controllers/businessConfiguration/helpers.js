
import { safeConsole } from "../../helpers/logging/safeLogger.js";
import Business from "../../models/business.js";










const getOwnerBusiness = async (req) => {
  const ownerId = req.user?.userId;
  if (!ownerId) return null;
  return Business.findOne({ owner: ownerId });
};

const respondNotFound = (res, message = "Business not found") =>
  res.status(404).json({ success: false, message });

const respondError = (res, error) => {
  if (error?.isJoi) {
    return res.status(400).json({
      success: false,
      message: error.details?.[0]?.message || error.message,
    });
  }

  if (error?.name === "CastError") {
    return res.status(400).json({ success: false, message: "Invalid identifier" });
  }

  if (error?.code === 11000) {
    return res.status(409).json({
      success: false,
      message: "A configuration record with these values already exists",
    });
  }

  safeConsole.error("Business configuration error:", error);
  return res.status(500).json({
    success: false,
    message: "Unable to process business configuration",
  });
};

export { getOwnerBusiness, respondError, respondNotFound };
