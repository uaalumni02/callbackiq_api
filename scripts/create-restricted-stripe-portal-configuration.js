import "dotenv/config";
import { getStripeClient } from "../src/helpers/stripe/stripeClient.js";

const stripe = getStripeClient();
if (!stripe?.billingPortal?.configurations?.create) {
  throw new Error("Stripe billing portal configuration API is unavailable.");
}

const clientUrl = process.env.CLIENT_URL || "http://localhost:3001";
const configuration = await stripe.billingPortal.configurations.create(
  {
    name: "CallBackIQ Restricted Billing Portal",
    default_return_url: `${clientUrl}/billing`,
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end",
        proration_behavior: "none",
        cancellation_reason: { enabled: false },
      },
      subscription_update: { enabled: false },
    },
    metadata: {
      app: "callbackiq",
      purpose: "restricted_billing_portal",
      version: "1",
    },
  },
  { idempotencyKey: "callbackiq:restricted-portal-configuration:v1" },
);

console.log("Restricted Stripe Billing Portal configuration created:");
console.log(`STRIPE_BILLING_PORTAL_CONFIGURATION_ID=${configuration.id}`);
