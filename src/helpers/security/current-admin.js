// CALLBACKIQ_PRODUCTION_HARDENING_V1
import User from "../../models/user.js";
import { assertAdminSession } from '../../services/security/adminSessionPolicy.js';

const normalizeRole = (role) => String(role || "").trim().toLowerCase();

export const getCurrentAuthorizationUser = async (req) => {
  const userId = req.user?.userId || req.user?._id || req.user?.id;
  if (!userId) return null;

  return User.findById(userId).select("_id role").lean();
};

export const isCurrentAdminRequest = async (req) => {
  const user = await getCurrentAuthorizationUser(req);
  if (!user || normalizeRole(user.role) !== 'admin') return false;
  assertAdminSession(req.user, req.method);
  return true;
};

export default isCurrentAdminRequest;
