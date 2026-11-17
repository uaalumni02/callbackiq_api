import { safeConsole } from "../helpers/logging/safeLogger.js";
import { isCurrentAdminRequest } from '../helpers/security/current-admin.js';

const requireAdmin = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    // Never trust a possibly stale role embedded in a long-lived JWT for an
    // administrative write. Re-read the current role from the database.
    if (!await isCurrentAdminRequest(req)) {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    req.user.role = "admin";
    return next();
  } catch (error) {
    if (error.statusCode === 401) return res.status(401).json({ success: false, code: error.code, message: error.message });
    safeConsole.error("Admin authorization check failed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to verify admin access",
    });
  }
};

export default requireAdmin;
