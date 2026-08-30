import express from "express";
import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
import inboundSmsLifecycle from "../middleware/inbound-sms-lifecycle.js";
import missedCallAutomationLifecycle from "../middleware/missed-call-automation-lifecycle.js";
import validateTwilioSignature from "../middleware/validate-twilio-signature.js";
import {
  manualSmsRateLimit,
  twilioSmsWebhookRateLimit,
  twilioStatusWebhookRateLimit,
  twilioVoiceWebhookRateLimit,
} from "../middleware/twilio-webhook-rate-limit.js";
import TwilioController from "../controllers/twilio.js";
import VoiceWebhookController from "../controllers/voiceWebhook.js";
import TrackingVoiceController from "../controllers/trackingVoice.controller.js";

const router = express.Router();

/*
 * Signature validation remains first for every public provider webhook. The
 * rate limiter therefore processes only requests Twilio authenticated, and
 * the controller's durable idempotency remains the final retry safeguard.
 */
router.post(
  "/voice",
  validateTwilioSignature,
  twilioVoiceWebhookRateLimit,
  TrackingVoiceController.initial,
  VoiceWebhookController.initial,
);
router.post(
  "/tracking-call-complete",
  validateTwilioSignature,
  twilioVoiceWebhookRateLimit,
  TrackingVoiceController.complete,
  VoiceWebhookController.initial,
);

router.post(
  "/voice-overflow",
  validateTwilioSignature,
  twilioVoiceWebhookRateLimit,
  VoiceWebhookController.overflow,
);
router.post(
  "/voice-complete",
  validateTwilioSignature,
  twilioVoiceWebhookRateLimit,
  VoiceWebhookController.complete,
);
router.post(
  "/voice-transfer-complete",
  validateTwilioSignature,
  twilioVoiceWebhookRateLimit,
  VoiceWebhookController.transferComplete,
);

router.post(
  "/voice-staff-screen",
  validateTwilioSignature,
  twilioVoiceWebhookRateLimit,
  VoiceWebhookController.staffScreen,
);

router.post(
  "/voice-staff-screen-decision",
  validateTwilioSignature,
  twilioVoiceWebhookRateLimit,
  VoiceWebhookController.staffScreenDecision,
);
router.post(
  "/status",
  validateTwilioSignature,
  twilioStatusWebhookRateLimit,
  missedCallAutomationLifecycle,
  TwilioController.statusWebhook,
);
router.post(
  "/sms",
  validateTwilioSignature,
  twilioSmsWebhookRateLimit,
  inboundSmsLifecycle,
  TwilioController.handleInboundSms,
);
router.post(
  "/send-sms",
  checkAuth,
  checkSubscription,
  manualSmsRateLimit,
  TwilioController.sendManualSms,
);

export default router;
