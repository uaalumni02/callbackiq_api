import express from "express";
import AdminController from "../controllers/admin.js";
import SupportController from "../controllers/support.js";
import checkAuth from "../middleware/check-auth.js";

const router = express.Router();

const requireAdmin = (req, res, next) => {
  const role = String(req.user?.role || "").toLowerCase();

  if (role !== "admin") {
    return res.status(401).json({
      success: false,
      message: "auth failed",
    });
  }

  return next();
};

router.get(
  "/dashboard",
  checkAuth,
  requireAdmin,
  AdminController.getAdminDashboard,
);

router.get(
  "/customers/:businessId",
  checkAuth,
  requireAdmin,
  AdminController.getCustomerDetails,
);

router.patch(
  "/customers/:businessId/subscription-status",
  checkAuth,
  requireAdmin,
  AdminController.updateSubscriptionStatus,
);

router.patch(
  "/customers/:businessId/business-status",
  checkAuth,
  requireAdmin,
  AdminController.updateBusinessStatus,
);

router.get(
  "/support/tickets",
  checkAuth,
  requireAdmin,
  SupportController.getAllTicketsAdmin,
);

router.patch(
  "/support/tickets/:id",
  checkAuth,
  requireAdmin,
  SupportController.updateTicketAdmin,
);

export default router;
