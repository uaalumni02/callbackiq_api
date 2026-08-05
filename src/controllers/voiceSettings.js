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
import { getVoiceSettingsContract, validateVoiceSettingsDraft } from "../services/voiceSettingsContract.service.js";
import {
  listVoiceSettingsVersions,
  publishVoiceSettingsVersion,
  rollbackVoiceSettingsVersion,
} from "../services/voiceSettingsVersion.service.js";
import {
  normalizePhoneToE164,
  phoneNumbersEqual,
} from "../voice/voicePhone.service.js";

const ANSWER_MODES = new Set([
  "after_hours",
  "overflow",
  "always",
  "disabled",
  "custom",
]);

const validationError = (message, statusCode = 400, code = "") => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

const serialize = (business) => normalizeVoiceSettings(business);

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

const normalizeRequiredPhone = (value, field) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = normalizePhoneToE164(raw);
  if (!normalized) {
    throw validationError(
      field === "liveTransferPhone"
        ? "Enter a valid live-transfer phone number."
        : "Enter a valid staff-routing phone number.",
    );
  }
  return normalized;
};

const cleanGreeting = (value) => {
  const greeting = String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (greeting.length > 300) {
    throw validationError("Welcome greeting cannot exceed 300 characters.");
  }
  return greeting;
};

export const validateUpdate = (body = {}, currentSettings = {}) => {
  const update = {};
  for (const key of [
    "voiceAiEnabled",
    "aiBookingEnabled",
    "liveTransferEnabled",
    "voiceHardCapEnabled",
    "voiceOverageEnabled",
    "agentConfirmationRequired",
    "answeringMachineDetectionEnabled",
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
      currentSettings.routingPolicy || getPresetRoutingPolicy("disabled"),
    );
  }
  if (Object.hasOwn(body, "overflowRingSeconds")) {
    const seconds = Number(body.overflowRingSeconds);
    if (!Number.isInteger(seconds) || seconds < 15 || seconds > 25) {
      throw validationError("Overflow ring seconds must be between 15 and 25.");
    }
    update.overflowRingSeconds = seconds;
  }
  if (Object.hasOwn(body, "maxCallDurationSeconds")) {
    const seconds = Number(body.maxCallDurationSeconds);
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 600) {
      throw validationError("Maximum call duration must be between 60 and 600 seconds.");
    }
    update.maxCallDurationSeconds = seconds;
  }
  if (Object.hasOwn(body, "maxConcurrentCalls")) {
    const calls = Number(body.maxConcurrentCalls);
    if (!Number.isInteger(calls) || calls < 1 || calls > 100) {
      throw validationError(
        "Maximum concurrent calls must be between 1 and 100.",
      );
    }
    update.maxConcurrentCalls = calls;
  }
  if (Object.hasOwn(body, "dailyVoiceMinutes")) {
    const minutes = Number(body.dailyVoiceMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 100000) {
      throw validationError(
        "Daily voice allowance must be between 1 and 100000 minutes.",
      );
    }
    update.dailyVoiceMinutes = minutes;
  }
  if (Object.hasOwn(body, "monthlyVoiceMinutes")) {
    const minutes = Number(body.monthlyVoiceMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1000000) {
      throw validationError(
        "Monthly voice allowance must be between 1 and 1000000 minutes.",
      );
    }
    update.monthlyVoiceMinutes = minutes;
  }
  if (Object.hasOwn(body, "callerVelocityLimitPerHour")) {
    const calls = Number(body.callerVelocityLimitPerHour);
    if (!Number.isInteger(calls) || calls < 1 || calls > 1000) {
      throw validationError(
        "Caller velocity limit must be between 1 and 1000 calls per hour.",
      );
    }
    update.callerVelocityLimitPerHour = calls;
  }
  if (Object.hasOwn(body, "transferPhone")) {
    update.transferPhone = normalizeRequiredPhone(
      body.transferPhone,
      "transferPhone",
    );
  }
  if (Object.hasOwn(body, "liveTransferPhone")) {
    update.liveTransferPhone = normalizeRequiredPhone(
      body.liveTransferPhone,
      "liveTransferPhone",
    );
  }
  if (Object.hasOwn(body, "welcomeGreeting")) {
    // Blank is intentional: it activates the dynamic business-name greeting.
    update.welcomeGreeting = cleanGreeting(body.welcomeGreeting);
  }
  if (Object.hasOwn(body, "voiceName")) {
    update.voiceName = String(body.voiceName || "").trim().slice(0, 80);
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

const assertNoDialLoops = ({ business, settings }) => {
  const trackingPhone = normalizePhoneToE164(business?.phone);
  const staffPhone = normalizePhoneToE164(settings.transferPhone);
  const livePhone = normalizePhoneToE164(settings.liveTransferPhone);
  if (staffPhone && trackingPhone && phoneNumbersEqual(staffPhone, trackingPhone)) {
    throw validationError(
      "The staff-routing phone cannot be the same CallBackIQ tracking number.",
      409,
      "VOICE_ROUTING_LOOP",
    );
  }
  if (livePhone && trackingPhone && phoneNumbersEqual(livePhone, trackingPhone)) {
    throw validationError(
      "The live-transfer phone cannot be the same CallBackIQ tracking number.",
      409,
      "VOICE_ROUTING_LOOP",
    );
  }
  if (livePhone && staffPhone && phoneNumbersEqual(livePhone, staffPhone)) {
    throw validationError(
      "Use a dedicated answered line for post-AI live transfer, separate from the initial staff-routing line.",
      409,
      "VOICE_TRANSFER_NUMBER_NOT_DEDICATED",
    );
  }
};

class VoiceSettingsController {
  // CALLBACKIQ_PRODUCTION_READINESS: one API/UI constraint contract.
  static async schema(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const current = serialize(business);
      return res.status(200).json({
        success: true,
        data: getVoiceSettingsContract({ currentVoiceName: current.voiceName }),
      });
    } catch (error) {
      return next(error);
    }
  }

  static async validateDraft(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body?.businessId,
      });
      const current = serialize(business);
      const draft = req.body?.settings || req.body || {};
      const result = validateVoiceSettingsDraft(draft, {
        currentVoiceName: current.voiceName,
      });
      return res.status(result.valid ? 200 : 400).json({
        success: result.valid,
        data: result,
        message: result.valid
          ? "Voice settings are valid."
          : result.errors.map((item) => item.message).join(" "),
      });
    } catch (error) {
      return next(error);
    }
  }
  static async versions(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.query.businessId });
      const versions = await listVoiceSettingsVersions({ businessId: business._id });
      return res.status(200).json({ success: true, data: versions });
    } catch (error) { return next(error); }
  }
  static async rollback(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.body?.businessId });
      const result = await rollbackVoiceSettingsVersion({
        business,
        version: req.params.version,
        publishedBy: req.user?.userId || req.user?._id || null,
        reason: req.body?.reason || "Voice settings rollback.",
      });
      return res.status(200).json({ success: true, data: serialize(result.business), publication: { version: result.published.version, rolledBackFromVersion: result.target.version } });
    } catch (error) { return next(error); }
  }
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
      const previousVoiceSettingsSnapshot = {
        features: {
          voiceAiEnabled: Boolean(business?.features?.voiceAiEnabled),
          aiBookingEnabled: Boolean(business?.features?.aiBookingEnabled),
        },
        voiceSettings: business?.voiceSettings?.toObject?.() || { ...(business?.voiceSettings || {}) },
      };

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
      const merged = {
        ...voiceSettings,
        answerMode,
        routingPolicyVersion: 1,
        routingPolicy,
        recordingEnabled: false,
      };
      for (const key of [
        "overflowRingSeconds",
        "maxCallDurationSeconds",
        "transferPhone",
        "liveTransferPhone",
        "welcomeGreeting",
        "voiceName",
        "liveTransferEnabled",
        "maxConcurrentCalls",
        "dailyVoiceMinutes",
        "monthlyVoiceMinutes",
        "voiceHardCapEnabled",
        "voiceOverageEnabled",
        "callerVelocityLimitPerHour",
        "agentConfirmationRequired",
        "answeringMachineDetectionEnabled",
      ]) {
        if (Object.hasOwn(update, key)) merged[key] = update[key];
      }

      assertNoDialLoops({ business, settings: merged });
      if (merged.liveTransferEnabled && !normalizePhoneToE164(merged.liveTransferPhone)) {
        throw validationError(
          "Configure a dedicated live-transfer phone before enabling live transfer.",
        );
      }

      business.set("features.voiceAiEnabled", voiceAiEnabled);
      if (Object.hasOwn(update, "aiBookingEnabled")) {
        business.set("features.aiBookingEnabled", update.aiBookingEnabled);
      }
      const contractValidation = validateVoiceSettingsDraft(
        { ...merged, voiceAiEnabled },
        { currentVoiceName: current.voiceName },
      );
      if (!contractValidation.valid) {
        throw validationError(
          contractValidation.errors.map((item) => item.message).join(" "),
          400,
          "VOICE_SETTINGS_CONTRACT_INVALID",
        );
      }
      business.set("voiceSettings", merged);
      const published = await publishVoiceSettingsVersion({
        business,
        previousSnapshot: previousVoiceSettingsSnapshot,
        publishedBy: req.user?.userId || req.user?._id || null,
        reason: req.body?.publishReason || "Voice settings published from dashboard.",
      });
      return res.status(200).json({
        success: true,
        data: serialize(business),
        publication: { version: published.version, warnings: contractValidation.warnings },
      });
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
      const trackingPhone = normalizePhoneToE164(business?.phone);
      const staffPhone = normalizePhoneToE164(settings.transferPhone);
      const livePhone = normalizePhoneToE164(settings.liveTransferPhone);
      const staffDistinct = !staffPhone || !phoneNumbersEqual(staffPhone, trackingPhone);
      const liveDistinct =
        !livePhone ||
        (!phoneNumbersEqual(livePhone, trackingPhone) &&
          !phoneNumbersEqual(livePhone, staffPhone));

      const checks = {
        voiceFeatureEnabled: settings.voiceAiEnabled,
        routingPolicyConfigured: settings.routingPolicyVersion >= 1,
        secureWebSocketConfigured:
          !usesVoiceAi || /^wss:\/\//i.test(getVoiceWebSocketUrl()),
        httpCallbackConfigured:
          !settings.voiceAiEnabled || /^https:\/\//i.test(getVoiceHttpBaseUrl()),
        twilioSignatureValidationConfigured:
          !usesVoiceAi || Boolean(String(process.env.TWILIO_AUTH_TOKEN || "").trim()),
        transferPhoneConfigured: !usesStaff || Boolean(staffPhone),
        transferPhoneIsDedicated: staffDistinct,
        liveTransferPhoneConfigured:
          !settings.liveTransferEnabled || Boolean(livePhone),
        liveTransferPhoneIsDedicated: liveDistinct,
        aiBookingEnabled: settings.aiBookingEnabled,
        callbackCaptureAvailable: Boolean(business?._id && business?.phone),
        recordingSupported: VOICE_RECORDING_SUPPORTED,
        recordingDisabled: settings.recordingEnabled === false,
        recordingPolicy: VOICE_RECORDING_POLICY,
        conversationRelayConfigured: !usesVoiceAi || relayConfigured,
        forcedFailureTestModeDisabled: !isPhase9ForcedRelayFailureEnabled(),
        maxCallDurationSafe:
          settings.maxCallDurationSeconds >= 60 &&
          settings.maxCallDurationSeconds <= 600,
        overflowWindowSafe:
          settings.overflowRingSeconds >= 15 &&
          settings.overflowRingSeconds <= 25,
      };
      const required = [
        "voiceFeatureEnabled",
        "routingPolicyConfigured",
        "httpCallbackConfigured",
        "transferPhoneConfigured",
        "transferPhoneIsDedicated",
        "liveTransferPhoneConfigured",
        "liveTransferPhoneIsDedicated",
        "recordingDisabled",
        "forcedFailureTestModeDisabled",
        "maxCallDurationSafe",
        "overflowWindowSafe",
        ...(usesVoiceAi
          ? [
              "secureWebSocketConfigured",
              "twilioSignatureValidationConfigured",
              "conversationRelayConfigured",
            ]
          : []),
      ];
      const voiceAnsweringReady = required.every((key) => Boolean(checks[key]));
      const blockers = required.filter((key) => !checks[key]);
      const warnings = [];
      if (!settings.aiBookingEnabled) {
        warnings.push(
          "Automatic booking is disabled. Voice AI will capture a verified callback instead of promising an appointment.",
        );
      }
      if (!settings.liveTransferEnabled) {
        warnings.push(
          "Post-AI live transfer is off. Explicit human requests will become priority callbacks.",
        );
      }
      if (!settings.configuredWelcomeGreeting) {
        warnings.push(
          `The dynamic greeting will identify ${business?.businessName || "the business"}.`,
        );
      }

      return res.status(200).json({
        success: true,
        data: {
          ready: voiceAnsweringReady,
          blockers,
          warnings,
          checks,
          capabilities: {
            voiceAnsweringReady,
            callbackCaptureReady: Boolean(checks.callbackCaptureAvailable),
            callbackCaptureEnabled: Boolean(checks.callbackCaptureAvailable),
            automaticBookingEnabled: settings.aiBookingEnabled,
            staffRoutingReady: !usesStaff || Boolean(staffPhone && staffDistinct),
            liveTransferReady:
              settings.liveTransferEnabled && Boolean(livePhone && liveDistinct),
            liveTransferEnabled:
              settings.liveTransferEnabled && Boolean(livePhone && liveDistinct),
          },
          recoveryPolicy: {
            bookingUnavailable: "capture_callback",
            lowConfidence: "capture_callback",
            unsupportedRequest: "capture_callback",
            explicitHumanRequest:
              settings.liveTransferEnabled && livePhone && liveDistinct
                ? "live_transfer_during_open_hours"
                : "capture_callback",
            liveTransferWindow: "configured_business_hours_only",
            transferAcceptanceMode: "press_1_screened",
            failedLiveTransfer: "callback_sms_and_alert",
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
