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

const serialize = (business) => ({
  ...normalizeVoiceSettings(business),
  aiBookingEnabled: Boolean(business?.features?.aiBookingEnabled),
  liveTransferEnabled: Boolean(
    business?.voiceSettings?.liveTransferEnabled,
  ),
  liveTransferPhone: String(
    business?.voiceSettings?.liveTransferPhone || "",
  ).trim(),
});

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

  for (const key of [
    "voiceAiEnabled",
    "aiBookingEnabled",
    "liveTransferEnabled",
  ]) {
    if (Object.hasOwn(body, key)) update[key] = Boolean(body[key]);
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

  for (const field of ["transferPhone", "liveTransferPhone"]) {
    if (!Object.hasOwn(body, field)) continue;

    const phone = String(body[field] || "").trim();
    if (phone && !PHONE_PATTERN.test(phone)) {
      throw validationError(
        field === "liveTransferPhone"
          ? "Enter a valid live-transfer phone number."
          : "Enter a valid staff-routing phone number.",
      );
    }
    update[field] = phone;
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
      if (Object.hasOwn(update, "aiBookingEnabled")) {
        business.set("features.aiBookingEnabled", update.aiBookingEnabled);
      }

      voiceSettings.answerMode = answerMode;
      voiceSettings.routingPolicyVersion = 1;
      voiceSettings.routingPolicy = routingPolicy;
      if (Object.hasOwn(update, "liveTransferEnabled")) {
        voiceSettings.liveTransferEnabled = update.liveTransferEnabled;
      }
      for (const key of [
        "overflowRingSeconds",
        "transferPhone",
        "liveTransferPhone",
        "welcomeGreeting",
        "voiceName",
      ]) {
        if (Object.hasOwn(update, key)) voiceSettings[key] = update[key];
      }

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
      const transferPhoneConfigured = Boolean(settings.transferPhone);
      const liveTransferPhoneConfigured = Boolean(
        settings.liveTransferPhone,
      );
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
        transferPhoneConfigured: !usesStaff || transferPhoneConfigured,
        liveTransferPhoneConfigured:
          !usesVoiceAi ||
          !settings.liveTransferEnabled ||
          liveTransferPhoneConfigured,
        aiBookingEnabled: settings.aiBookingEnabled,
        callbackCaptureAvailable: true,
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
        "liveTransferPhoneConfigured",
        "recordingDisabled",
        "forcedFailureTestModeDisabled",
        ...(usesVoiceAi
          ? [
              "secureWebSocketConfigured",
              "twilioSignatureValidationConfigured",
              "conversationRelayConfigured",
            ]
          : []),
      ];
      const voiceAnsweringReady = required.every((key) => checks[key]);

      return res.status(200).json({
        success: true,
        data: {
          ready: voiceAnsweringReady,
          checks,
          capabilities: {
            voiceAnsweringReady,
            callbackCaptureEnabled: true,
            automaticBookingEnabled: settings.aiBookingEnabled,
            liveTransferEnabled:
              settings.liveTransferEnabled && liveTransferPhoneConfigured,
          },
          recoveryPolicy: {
            bookingUnavailable: "capture_callback",
            lowConfidence: "capture_callback",
            unsupportedRequest: "capture_callback",
            explicitHumanRequest:
              settings.liveTransferEnabled && liveTransferPhoneConfigured
                ? "live_transfer_during_open_hours"
                : "capture_callback",
            liveTransferWindow: "configured_business_hours_only",
            failedLiveTransfer: "sms_and_alert",
          },
          requirements: { usesVoiceAi, usesStaff },
          settings,
        },
      });
    } catch (error) {
      return next(error);
    }
  }
}

export default VoiceSettingsController;
