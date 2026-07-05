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
      message: "Admin access required.",
    });
  }

  return next();
};

router.get("/dashboard", checkAuth, requireAdmin, AdminController.getAdminDashboard);

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