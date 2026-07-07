import express from "express";

import checkAuth from "../middleware/check-auth.js";
import BillingController from "../controllers/billing.js";

const router = express.Router();

router.post("/free-trial", checkAuth, BillingController.startFreeTrial);

router.post(
  "/create-checkout-session",
  checkAuth,
  BillingController.createCheckoutSession,
);

router.get("/subscription", checkAuth, BillingController.getMySubscription);

router.get("/invoices", checkAuth, BillingController.getBillingHistory);

router.post(
  "/create-portal-session",
  checkAuth,
  BillingController.createBillingPortalSession,
);

router.post("/cancel", checkAuth, BillingController.cancelSubscription);

router.patch(
  "/customers/:businessId/account-status",
  checkAuth,
  BillingController.updateAdminCustomerAccountStatus,
);

export default router;
