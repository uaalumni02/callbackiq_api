import {
  saveProviderBalance,
  removeProviderBalance,
  refreshProviderBalances,
} from "../controllers/adminReporting.js";
import express from "express";
import AdminController from "../controllers/admin.js";
import SupportController from "../controllers/support.js";
import checkAuth from "../middleware/check-auth.js";

import requireAdmin from "../middleware/require-admin.js";
import {
  getFounderDashboard,
  getFounderCustomers,
  getFounderCustomer,
  updateReportingProfile,
  saveReportingCost,
  saveCompanyExpense,
  refreshCompanyExpenses,
  removeExpenseOverride,
} from "../controllers/adminReporting.js";
import rateLimit from "express-rate-limit";
import { readScaleHealth } from '../services/scaleHealth.service.js';
const router = express.Router();
router.get('/scale-health', checkAuth, requireAdmin, rateLimit({ windowMs: 60000, limit: 30 }), async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store').json({ success: true, data: await readScaleHealth() }); }
  catch (error) { next(error); }
});
router.put("/balances", checkAuth, requireAdmin, saveProviderBalance);
router.delete(
  "/balances/:provider/manual",
  checkAuth,
  requireAdmin,
  removeProviderBalance,
);
router.post(
  "/balances/refresh",
  checkAuth,
  requireAdmin,
  rateLimit({ windowMs: 60000, limit: 3 }),
  refreshProviderBalances,
);
router.put("/expenses", checkAuth, requireAdmin, saveCompanyExpense);
router.delete(
  "/expenses/:provider/:period/manual",
  checkAuth,
  requireAdmin,
  removeExpenseOverride,
);
router.post(
  "/expenses/refresh",
  checkAuth,
  requireAdmin,
  rateLimit({ windowMs: 60000, limit: 3 }),
  refreshCompanyExpenses,
);
router.get("/customers", checkAuth, requireAdmin, getFounderCustomers);
router.patch(
  "/customers/:businessId/reporting-profile",
  checkAuth,
  requireAdmin,
  updateReportingProfile,
);
router.put(
  "/customers/:businessId/reporting-cost",
  checkAuth,
  requireAdmin,
  saveReportingCost,
);

router.get("/dashboard", checkAuth, requireAdmin, getFounderDashboard);

router.get(
  "/customers/:businessId",
  checkAuth,
  requireAdmin,
  getFounderCustomer,
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
