import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import TwilioController from "../controllers/twilio.js";

const router = express.Router();

/*
  Public Twilio webhooks.
  Do NOT use checkAuth here because Twilio does not send JWT tokens.
*/
router.post("/voice", TwilioController.voiceWebhook);

router.post("/status", TwilioController.statusWebhook);

router.post("/sms", TwilioController.smsWebhook);

/*
  Protected manual SMS route from your app/dashboard.
*/
router.post(
  "/send-sms",
  checkAuth,
  checkSubscription,
  TwilioController.sendManualSms,
);

export default router;
