import express from "express";

import checkAuth from "../middleware/check-auth.js";
import TwilioController from "../controllers/twilio.js";

const router = express.Router();

router.post("/voice", TwilioController.voiceWebhook);

router.post("/status", TwilioController.statusWebhook);

router.post("/sms", TwilioController.smsWebhook);

router.post("/send-sms", checkAuth, TwilioController.sendManualSms);

export default router;
