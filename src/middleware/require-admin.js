import { safeConsole } from "../helpers/logging/safeLogger.js";
import User from "../models/user.js";

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
    const user = await User.findById(userId).select("role").lean();
    if (!user || String(user.role || "").toLowerCase() !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    if (req.user.mfaVerified !== true) return res.status(401).json({ success: false, code: 'ADMIN_MFA_REQUIRED', message: 'Sign in with administrator verification.' });
    const age = Math.floor(Date.now() / 1000) - Number(req.user.authTime || 0);
    if (!Number.isFinite(age) || age < 0 || age > (['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 28800 : 900)) return res.status(401).json({ success: false, code: 'ADMIN_REAUTH_REQUIRED', message: 'Sign in again before continuing this administrator action.' });
    req.user.role = "admin";
    return next();
  } catch (error) {
    safeConsole.error("Admin authorization check failed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to verify admin access",
    });
  }
};

export default requireAdmin;
