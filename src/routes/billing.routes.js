import express from "express";

import checkAuth from "../middleware/check-auth.js";
import BillingController from "../controllers/billing.js";
import requireAdmin from "../middleware/require-admin.js";
import trialActivationRateLimit from "../middleware/trial-activation-rate-limit.js";

const router = express.Router();

/*
 * All routes in this router are user or administrator operations. The Stripe
 * webhook is mounted through stripeWebhook.routes.js before this router.
 */
router.use(checkAuth);

router.post(
  "/free-trial",
  trialActivationRateLimit,
  BillingController.startFreeTrial,
);

router.post(
  "/create-checkout-session",
  BillingController.createCheckoutSession,
);

router.get("/subscription", BillingController.getMySubscription);

router.get("/invoices", BillingController.getBillingHistory);

router.post(
  "/create-portal-session",
  BillingController.createBillingPortalSession,
);

router.post("/cancel", BillingController.cancelSubscription);

router.patch(
  "/customers/:businessId/account-status",
  requireAdmin,
  BillingController.updateAdminCustomerAccountStatus,
);

router.post(
  "/customers/:businessId/trial-override",
  requireAdmin,
  BillingController.adminGrantTrialOverride,
);

export default router;
