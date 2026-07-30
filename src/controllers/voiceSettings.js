import { getOwnedBusiness } from "../services/businessScope.service.js";
import {
  getPresetRoutingPolicy,
  getVoiceHttpBaseUrl,
  getVoiceWebSocketUrl,
  inferAnswerMode,
  isConversationRelayConfigured,
  isPhase9ForcedRelayFailureEnabled,
  normalizeVoiceSettings,
  routingPolicyUsesStaff,
  routingPolicyUsesVoiceAi,
  VOICE_FAILURE_ACTIONS,
  VOICE_RECORDING_POLICY,
  VOICE_RECORDING_SUPPORTED,
  VOICE_ROUTING_ACTIONS,
} from "../voice/voiceRouting.service.js";

const ANSWER_MODES = new Set([
  "after_hours",
  "overflow",
  "always",
  "disabled",
  "custom",
]);
const PHONE_PATTERN = /^\+?[0-9()\-.\s]{7,20}$/;

const serialize = (business) => normalizeVoiceSettings(business);

const validationError = (message, statusCode = 400, code = "") => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

const validateRoutingPolicy = (value, currentPolicy) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("Voice routing policy must be an object.");
  }

  const policy = { ...currentPolicy };
  for (const key of ["openHours", "afterHours"]) {
    if (!Object.hasOwn(value, key)) continue;
    if (!VOICE_ROUTING_ACTIONS.includes(value[key])) {
      throw validationError(`Invalid ${key} voice routing action.`);
    }
    policy[key] = value[key];
  }

  if (Object.hasOwn(value, "voiceFailure")) {
    if (!VOICE_FAILURE_ACTIONS.includes(value.voiceFailure)) {
      throw validationError("Invalid voice failure routing action.");
    }
    policy.voiceFailure = value.voiceFailure;
  }

  return policy;
};

const validateUpdate = (body, currentSettings) => {
  const update = {};

  if (Object.hasOwn(body, "voiceAiEnabled")) {
    update.voiceAiEnabled = Boolean(body.voiceAiEnabled);
  }

  if (Object.hasOwn(body, "answerMode")) {
    if (!ANSWER_MODES.has(body.answerMode)) {
      throw validationError("Invalid voice answer mode.");
    }
    update.answerMode = body.answerMode;
  }

  if (Object.hasOwn(body, "routingPolicy")) {
    update.routingPolicy = validateRoutingPolicy(
      body.routingPolicy,
      currentSettings.routingPolicy,
    );
  }

  if (Object.hasOwn(body, "overflowRingSeconds")) {
    const seconds = Number(body.overflowRingSeconds);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 60) {
      throw validationError("Overflow ring seconds must be between 5 and 60.");
    }
    update.overflowRingSeconds = seconds;
  }

  if (Object.hasOwn(body, "transferPhone")) {
    const phone = String(body.transferPhone || "").trim();
    if (phone && !PHONE_PATTERN.test(phone)) {
      throw validationError("Enter a valid transfer phone number.");
    }
    update.transferPhone = phone;
  }

  if (Object.hasOwn(body, "welcomeGreeting")) {
    const greeting = String(body.welcomeGreeting || "").trim();
    if (!greeting || greeting.length > 300) {
      throw validationError("Welcome greeting must be 1 to 300 characters.");
    }
    update.welcomeGreeting = greeting;
  }

  if (Object.hasOwn(body, "voiceName")) {
    update.voiceName = String(body.voiceName || "").trim().slice(0, 200);
  }

  if (Object.hasOwn(body, "recordingEnabled")) {
    if (Boolean(body.recordingEnabled)) {
      throw validationError(
        "Voice recording is disabled until CallBackIQ has an approved consent, disclosure, access, retention, and deletion policy.",
        409,
        "VOICE_RECORDING_NOT_AVAILABLE",
      );
    }
    update.recordingEnabled = false;
  }

  return update;
};

const voiceSettingsObject = (business) => ({
  ...(business.voiceSettings?.toObject?.() || business.voiceSettings || {}),
});

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
      const current = serialize(business);
      const update = validateUpdate(req.body || {}, current);
      const voiceSettings = voiceSettingsObject(business);

      let voiceAiEnabled = Object.hasOwn(update, "voiceAiEnabled")
        ? update.voiceAiEnabled
        : current.voiceAiEnabled;
      let routingPolicy = { ...current.routingPolicy };

      // Presets remain available for backward compatibility and quick setup.
      // Scenario-specific fields take precedence and make the mode custom when
      // they do not exactly match a preset.
      if (
        Object.hasOwn(update, "answerMode") &&
        update.answerMode !== "custom" &&
        !Object.hasOwn(update, "routingPolicy")
      ) {
        routingPolicy = getPresetRoutingPolicy(update.answerMode);
        voiceAiEnabled = update.answerMode !== "disabled";
      }

      if (Object.hasOwn(update, "routingPolicy")) {
        routingPolicy = update.routingPolicy;
      }

      const answerMode = inferAnswerMode({ voiceAiEnabled, routingPolicy });
      business.set("features.voiceAiEnabled", voiceAiEnabled);

      voiceSettings.answerMode = answerMode;
      voiceSettings.routingPolicyVersion = 1;
      voiceSettings.routingPolicy = routingPolicy;

      for (const key of [
        "overflowRingSeconds",
        "transferPhone",
        "welcomeGreeting",
        "voiceName",
      ]) {
        if (Object.hasOwn(update, key)) voiceSettings[key] = update[key];
      }

      // Clear every legacy true value. No Phase 9 TwiML can enable recording.
      voiceSettings.recordingEnabled = false;

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
      const usesVoiceAi = routingPolicyUsesVoiceAi(settings.routingPolicy);
      const usesStaff = routingPolicyUsesStaff(settings.routingPolicy);
      const relayConfigured = isConversationRelayConfigured();

      const checks = {
        voiceFeatureEnabled: settings.voiceAiEnabled,
        routingPolicyConfigured:
          settings.routingPolicyVersion >= 1 ||
          settings.answerMode !== "custom",
        secureWebSocketConfigured:
          !usesVoiceAi || /^wss:\/\//i.test(getVoiceWebSocketUrl()),
        httpCallbackConfigured:
          !settings.voiceAiEnabled || /^https:\/\//i.test(getVoiceHttpBaseUrl()),
        twilioSignatureValidationConfigured:
          !usesVoiceAi || Boolean(process.env.TWILIO_AUTH_TOKEN),
        aiBookingEnabled:
          !usesVoiceAi || Boolean(business.features?.aiBookingEnabled),
        transferPhoneConfigured: !usesStaff || Boolean(settings.transferPhone),
        recordingSupported: VOICE_RECORDING_SUPPORTED,
        recordingDisabled: settings.recordingEnabled === false,
        recordingPolicy: VOICE_RECORDING_POLICY,
        recordingAcknowledged: settings.recordingEnabled === false,
        conversationRelayConfigured: !usesVoiceAi || relayConfigured,
        forcedFailureTestModeDisabled:
          !isPhase9ForcedRelayFailureEnabled(),
      };

      const required = [
        "voiceFeatureEnabled",
        "routingPolicyConfigured",
        "httpCallbackConfigured",
        "transferPhoneConfigured",
        "recordingDisabled",
        "forcedFailureTestModeDisabled",
        ...(usesVoiceAi
          ? [
              "secureWebSocketConfigured",
              "twilioSignatureValidationConfigured",
              "aiBookingEnabled",
              "conversationRelayConfigured",
            ]
          : []),
      ];

      return res.status(200).json({
        success: true,
        data: {
          ready: required.every((key) => checks[key]),
          checks,
          requirements: {
            usesVoiceAi,
            usesStaff,
          },
          settings,
        },
      });
    } catch (error) {
      return next(error);
    }
  }
}

export default VoiceSettingsController;
