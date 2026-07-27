import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import inboundSmsLifecycle from "../middleware/inbound-sms-lifecycle.js";
import missedCallAutomationLifecycle from "../middleware/missed-call-automation-lifecycle.js";
import validateTwilioSignature from "../middleware/validate-twilio-signature.js";
import TwilioController from "../controllers/twilio.js";

const router = express.Router();

/*
 * Public Twilio webhook endpoints. Signature validation remains first.
 * The SMS lifecycle middleware only cancels obsolete durable follow-ups and
 * records the response event; the existing controller retains ownership of
 * idempotency, STOP/HELP, safety, qualification, AI, sending and persistence.
 */
router.post("/voice", validateTwilioSignature, TwilioController.voiceWebhook);
router.post(
  "/status",
  validateTwilioSignature,
  missedCallAutomationLifecycle,
  TwilioController.statusWebhook,
);
router.post(
  "/sms",
  validateTwilioSignature,
  inboundSmsLifecycle,
  TwilioController.handleInboundSms,
);

router.post(
  "/send-sms",
  checkAuth,
  checkSubscription,
  TwilioController.sendManualSms,
);

export default router;
