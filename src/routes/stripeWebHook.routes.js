import express from "express";

import BillingController from "../controllers/billing.js";

const router = express.Router();

router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  BillingController.handleStripeWebhook,
);

export default router;
