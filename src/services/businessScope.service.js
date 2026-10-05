import mongoose from "mongoose";
import Business from "../models/business.js";

export const getOwnedBusiness = async ({ user, requestedBusinessId = null }) => {
  const userId = user?.userId || user?._id || user?.id;
  if (!userId) {
    const error = new Error("Not authenticated.");
    error.statusCode = 401;
    throw error;
  }
  const role = String(user?.role || "").toLowerCase();
  const isAdmin = ["admin", "administrator", "superadmin", "super_admin"].includes(role);
  const hasRequestedBusiness = requestedBusinessId != null && requestedBusinessId !== "";
  if (hasRequestedBusiness && !mongoose.isObjectIdOrHexString(requestedBusinessId)) {
    const error = new Error("Invalid business ID.");
    error.statusCode = 400;
    throw error;
  }
  // An explicit ID narrows owner scope; it must never silently select a
  // different business. Admins retain their existing cross-business access.
  const query = hasRequestedBusiness
    ? { _id: requestedBusinessId, ...(isAdmin ? {} : { owner: userId }) }
    : { owner: userId };
  const business = await Business.findOne(query);

  if (!business) {
    const error = new Error("Business not found.");
    error.statusCode = 404;
    throw error;
  }

  return business;
};

export default getOwnedBusiness;
