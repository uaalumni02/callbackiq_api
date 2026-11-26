import { withPilotVoiceBudget } from "../config/pilotBudgets.js";
import {
  validateUpdate,
  assertNoDialLoops,
} from "../controllers/voiceSettings.js";
import {
  normalizeVoiceSettings,
  getPresetRoutingPolicy,
  inferAnswerMode,
} from "../voice/voiceRouting.service.js";
import { validateVoiceSettingsDraft } from "./voiceSettingsContract.service.js";
const pick = (object, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => object?.[key] !== undefined)
      .map((key) => [key, object[key]]),
  );
const plain = (value) => value?.toObject?.() || value;
/** Stages validated owner call settings with immutable pilot limits; throws before persistence on invalid routing. */
export function applyOwnerCallSettings({ business, values }) {
  const current = normalizeVoiceSettings(business);
  const voiceInput = pick(values, [
    "answerMode",
    "transferPhone",
    "welcomeGreeting",
    "overflowRingSeconds",
    "liveTransferEnabled",
    "liveTransferPhone",
  ]);
  const update = validateUpdate(voiceInput, current);
  const voiceEnabled =
    values.answerMode === "custom"
      ? current.voiceAiEnabled
      : values.answerMode !== "disabled";
  const routingPolicy =
    values.answerMode === "custom"
      ? current.routingPolicy
      : getPresetRoutingPolicy(values.answerMode);
  const merged = withPilotVoiceBudget({
    ...plain(business.voiceSettings),
    ...update,
    routingPolicy,
    routingPolicyVersion: 1,
    recordingEnabled: false,
  });
  merged.answerMode = inferAnswerMode({
    voiceAiEnabled: voiceEnabled,
    routingPolicy,
  });
  assertNoDialLoops({ business, settings: merged });
  merged.liveTransferEnabled = false;
  merged.liveTransferPhone = "";
  const validation = validateVoiceSettingsDraft(
    { ...current, ...merged, voiceAiEnabled: voiceEnabled },
    { currentVoiceName: current.voiceName },
  );
  if (!validation.valid)
    throw Object.assign(
      new Error(validation.errors.map((e) => e.message).join(" ")),
      { statusCode: 400 },
    );
  business.set("voiceSettings", merged);
  business.set("features.voiceAiEnabled", voiceEnabled);
  business.set("features.missedCallSmsEnabled", values.missedCallSmsEnabled);
  business.set("customerMessaging", {
    ...pick(values, [
      "automaticTextsEnabled",
      "voiceTextsEnabled",
      "appointmentTextsEnabled",
    ]),
    configured: true,
  });
  business.set("smsTemplate", values.smsTemplate);
}
