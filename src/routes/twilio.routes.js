import express from "express";

import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import TwilioController from "../controllers/twilio.js";

const router = express.Router();

/*
  Public Twilio webhooks.
  Do NOT use checkAuth here because Twilio does not send JWT tokens.

  Your controller currently has:
  TwilioController.handleInboundSms

  So the SMS webhook route must point to that method.
*/
router.post("/sms", TwilioController.handleInboundSms);

/*
  Temporarily disabled because these methods do not exist yet
  in controllers/twilio.js.

  Add them back only after creating:
  - TwilioController.voiceWebhook
  - TwilioController.statusWebhook
  - TwilioController.sendManualSms
*/

// router.post("/voice", TwilioController.voiceWebhook);

// router.post("/status", TwilioController.statusWebhook);

// router.post(
//   "/send-sms",
//   checkAuth,
//   checkSubscription,
//   TwilioController.sendManualSms,
// );

export default router;