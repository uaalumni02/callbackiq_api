import { getOwnedBusiness } from "../../services/businessScope.service.js";

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
} from "../../voice/voiceRouting.service.js";

import { getVoiceSettingsContract, validateVoiceSettingsDraft } from "../../services/voiceSettingsContract.service.js";

import {
  listVoiceSettingsVersions,
  publishVoiceSettingsVersion,
  rollbackVoiceSettingsVersion,
} from "../../services/voiceSettingsVersion.service.js";

import {
  normalizePhoneToE164,
  phoneNumbersEqual,
} from "../../voice/voicePhone.service.js";

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
    .replace(/\p{Cc}/ug, " ")
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
    if (body.recordingEnabled) {
      throw validationError(
        "Voice recording is disabled until MeekCall has an approved consent, disclosure, access, retention, and deletion policy.",
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

export const assertNoDialLoops = ({ business, settings }) => {
  const trackingPhone = normalizePhoneToE164(business?.phone);
  const staffPhone = normalizePhoneToE164(settings.transferPhone);
  const livePhone = normalizePhoneToE164(settings.liveTransferPhone);
  if (staffPhone && trackingPhone && phoneNumbersEqual(staffPhone, trackingPhone)) {
    throw validationError(
      "The staff-routing phone cannot be the same MeekCall tracking number.",
      409,
      "VOICE_ROUTING_LOOP",
    );
  }
  if (livePhone && trackingPhone && phoneNumbersEqual(livePhone, trackingPhone)) {
    throw validationError(
      "The live-transfer phone cannot be the same MeekCall tracking number.",
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

export { getOwnedBusiness, getVoiceSettingsContract, serialize, validateVoiceSettingsDraft, listVoiceSettingsVersions, rollbackVoiceSettingsVersion, getPresetRoutingPolicy, inferAnswerMode, normalizePhoneToE164, publishVoiceSettingsVersion, validationError, voiceSettingsObject, VOICE_RECORDING_POLICY, VOICE_RECORDING_SUPPORTED, getVoiceHttpBaseUrl, getVoiceWebSocketUrl, isConversationRelayConfigured, isPhase9ForcedRelayFailureEnabled, phoneNumbersEqual, routingPolicyUsesStaff, routingPolicyUsesVoiceAi };

