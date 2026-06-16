import express from "express";

import checkAuth from "../middleware/check-auth.js";
import BillingController from "../controllers/billing.js";

const router = express.Router();

router.post(
  "/create-checkout-session",
  checkAuth,
  BillingController.createCheckoutSession,
);

router.get("/subscription", checkAuth, BillingController.getMySubscription);

router.post("/cancel", checkAuth, BillingController.cancelSubscription);

export default router;
