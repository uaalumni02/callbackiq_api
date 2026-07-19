import express from "express";

import BillingController from "../controllers/billing.js";

const router = express.Router();

/*
  Stripe webhook endpoint:

  POST /api/billing/webhook

  The "/api/billing" portion is added when this router is mounted
  in app.js.

  Do not add checkAuth to this route. Stripe authenticates webhook
  requests through the stripe-signature header.

  express.raw() preserves the original request body required by
  stripe.webhooks.constructEvent().
*/
router.post(
  "/webhook",
  express.raw({
    type: "application/json",
  }),
  BillingController.handleStripeWebhook,
);

export default router;
