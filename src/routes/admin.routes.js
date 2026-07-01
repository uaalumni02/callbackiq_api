import express from "express";
import AdminController from "../controllers/admin.js";
import SupportController from "../controllers/support.js";
import checkAuth from "../middleware/check-auth.js";

const router = express.Router();

router.get("/dashboard", checkAuth, AdminController.getAdminDashboard);

router.get(
  "/customers/:businessId",
  checkAuth,
  AdminController.getCustomerDetails,
);

router.patch(
  "/customers/:businessId/subscription-status",
  checkAuth,
  AdminController.updateSubscriptionStatus,
);

router.patch(
  "/customers/:businessId/business-status",
  checkAuth,
  AdminController.updateBusinessStatus,
);

router.get("/support/tickets", checkAuth, SupportController.getAllTicketsAdmin);
router.patch(
  "/support/tickets/:id",
  checkAuth,
  SupportController.updateTicketAdmin,
);

export default router;
