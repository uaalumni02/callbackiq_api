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
