import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import TwilioController from "../controllers/twilio.js";

const router = express.Router();

router.post("/voice", TwilioController.voiceWebhook);
router.post("/status", TwilioController.statusWebhook);
router.post("/sms", TwilioController.handleInboundSms);

router.post(
  "/send-sms",
  checkAuth,
  checkSubscription,
  TwilioController.sendManualSms,
);

export default router;
