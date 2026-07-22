import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import validateTwilioSignature from "../middleware/validate-twilio-signature.js";
import TwilioController from "../controllers/twilio.js";

const router = express.Router();

/*
 * Public Twilio webhook endpoints.
 *
 * These routes must not use checkAuth because Twilio is the caller. Instead,
 * validate the X-Twilio-Signature header before allowing a request to create
 * calls, leads, conversations, messages, alerts, or AI replies.
 */
router.post(
  "/voice",
  validateTwilioSignature,
  TwilioController.voiceWebhook,
);

router.post(
  "/status",
  validateTwilioSignature,
  TwilioController.statusWebhook,
);

router.post(
  "/sms",
  validateTwilioSignature,
  TwilioController.handleInboundSms,
);

/*
 * Authenticated in-app SMS endpoint.
 */
router.post(
  "/send-sms",
  checkAuth,
  checkSubscription,
  TwilioController.sendManualSms,
);

export default router;