// CALLBACKIQ_PRODUCTION_HARDENING_V1
import User from "../../models/user.js";

const ADMIN_ROLES = new Set([
  "admin",
  "administrator",
  "superadmin",
  "super_admin",
]);

const normalizeRole = (role) => String(role || "").trim().toLowerCase();

export const getCurrentAuthorizationUser = async (req) => {
  const userId = req.user?.userId || req.user?._id || req.user?.id;
  if (!userId) return null;

  return User.findById(userId).select("_id role").lean();
};

export const isCurrentAdminRequest = async (req) => {
  const user = await getCurrentAuthorizationUser(req);
  return Boolean(user && ADMIN_ROLES.has(normalizeRole(user.role)));
};

export default isCurrentAdminRequest;
