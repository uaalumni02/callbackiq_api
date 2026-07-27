import Business from "../models/business.js";

export const getOwnedBusiness = async ({ user, requestedBusinessId = null }) => {
  const userId = user?.userId || user?._id || user?.id;
  const role = String(user?.role || "").toLowerCase();
  const isAdmin = ["admin", "administrator", "superadmin", "super_admin"].includes(role);
  const query = isAdmin && requestedBusinessId
    ? { _id: requestedBusinessId }
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
