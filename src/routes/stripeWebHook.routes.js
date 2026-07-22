import express from "express";

import BillingController from "../controllers/billing.js";

const router = express.Router();

/*
 * Stripe webhook endpoint:
 *
 * POST /api/billing/webhook
 *
 * Do not add checkAuth. Stripe authenticates requests with the
 * stripe-signature header.
 *
 * express.raw() must remain before express.json() in app.js.
 */
router.post(
  "/webhook",
  express.raw({
    type: "application/json",
    limit: process.env.STRIPE_WEBHOOK_BODY_LIMIT || "1mb",
  }),
  BillingController.handleStripeWebhook,
);

export default router;
