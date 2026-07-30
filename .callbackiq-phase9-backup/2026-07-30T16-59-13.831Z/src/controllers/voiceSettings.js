import { getOwnedBusiness } from "../services/businessScope.service.js";
import {
  getVoiceHttpBaseUrl,
  getVoiceWebSocketUrl,
  isConversationRelayConfigured,
  normalizeVoiceSettings,
} from "../voice/voiceRouting.service.js";

const ANSWER_MODES = new Set(["after_hours", "overflow", "always", "disabled"]);
const PHONE_PATTERN = /^\+?[0-9()\-.\s]{7,20}$/;

const serialize = (business) => normalizeVoiceSettings(business);

const validateUpdate = (body) => {
  const update = {};
  if (Object.hasOwn(body, "voiceAiEnabled")) {
    update.voiceAiEnabled = Boolean(body.voiceAiEnabled);
  }
  if (Object.hasOwn(body, "answerMode")) {
    if (!ANSWER_MODES.has(body.answerMode)) {
      const error = new Error("Invalid voice answer mode.");
      error.statusCode = 400;
      throw error;
    }
    update.answerMode = body.answerMode;
  }
  if (Object.hasOwn(body, "overflowRingSeconds")) {
    const seconds = Number(body.overflowRingSeconds);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 60) {
      const error = new Error("Overflow ring seconds must be between 5 and 60.");
      error.statusCode = 400;
      throw error;
    }
    update.overflowRingSeconds = seconds;
  }
  if (Object.hasOwn(body, "transferPhone")) {
    const phone = String(body.transferPhone || "").trim();
    if (phone && !PHONE_PATTERN.test(phone)) {
      const error = new Error("Enter a valid transfer phone number.");
      error.statusCode = 400;
      throw error;
    }
    update.transferPhone = phone;
  }
  if (Object.hasOwn(body, "welcomeGreeting")) {
    const greeting = String(body.welcomeGreeting || "").trim();
    if (!greeting || greeting.length > 300) {
      const error = new Error("Welcome greeting must be 1 to 300 characters.");
      error.statusCode = 400;
      throw error;
    }
    update.welcomeGreeting = greeting;
  }
  if (Object.hasOwn(body, "voiceName")) {
    update.voiceName = String(body.voiceName || "").trim().slice(0, 200);
  }
  if (Object.hasOwn(body, "recordingEnabled")) {
    update.recordingEnabled = Boolean(body.recordingEnabled);
  }
  return update;
};

class VoiceSettingsController {
  static async get(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      return res.status(200).json({ success: true, data: serialize(business) });
    } catch (error) {
      return next(error);
    }
  }

  static async update(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body.businessId,
      });
      const update = validateUpdate(req.body || {});
      if (Object.hasOwn(update, "voiceAiEnabled")) {
        business.set("features.voiceAiEnabled", update.voiceAiEnabled);
      }
      const voiceSettings = { ...(business.voiceSettings?.toObject?.() || business.voiceSettings || {}) };
      for (const key of [
        "answerMode",
        "overflowRingSeconds",
        "transferPhone",
        "welcomeGreeting",
        "voiceName",
        "recordingEnabled",
      ]) {
        if (Object.hasOwn(update, key)) voiceSettings[key] = update[key];
      }
      business.set("voiceSettings", voiceSettings);
      await business.save();
      return res.status(200).json({ success: true, data: serialize(business) });
    } catch (error) {
      return next(error);
    }
  }

  static async readiness(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const settings = serialize(business);
      const checks = {
        voiceFeatureEnabled: settings.voiceAiEnabled,
        answerModeEnabled: settings.answerMode !== "disabled",
        secureWebSocketConfigured: /^wss:\/\//i.test(getVoiceWebSocketUrl()),
        httpCallbackConfigured: /^https:\/\//i.test(getVoiceHttpBaseUrl()),
        twilioSignatureValidationConfigured: Boolean(process.env.TWILIO_AUTH_TOKEN),
        aiBookingEnabled: Boolean(business.features?.aiBookingEnabled),
        transferPhoneConfigured: Boolean(settings.transferPhone),
        recordingAcknowledged:
          !settings.recordingEnabled ||
          process.env.VOICE_RECORDING_ACKNOWLEDGED === "true",
        conversationRelayConfigured: isConversationRelayConfigured(),
      };
      const required = [
        "voiceFeatureEnabled",
        "answerModeEnabled",
        "secureWebSocketConfigured",
        "httpCallbackConfigured",
        "twilioSignatureValidationConfigured",
        "aiBookingEnabled",
        "transferPhoneConfigured",
        "recordingAcknowledged",
        "conversationRelayConfigured",
      ];
      return res.status(200).json({
        success: true,
        data: {
          ready: required.every((key) => checks[key]),
          checks,
          settings,
        },
      });
    } catch (error) {
      return next(error);
    }
  }
}

export default VoiceSettingsController;
