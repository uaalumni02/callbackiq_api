const escapeXml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const trimTrailingSlash = (value) => String(value || "").replace(/\/+$/, "");

export const VOICE_RECORDING_SUPPORTED = false;
export const VOICE_RECORDING_POLICY =
  "disabled_pending_consent_and_retention_policy";

export const VOICE_ROUTING_ACTIONS = Object.freeze([
  "voice_ai",
  "sms",
  "staff_then_voice_ai",
  "staff_then_sms",
]);

export const VOICE_FAILURE_ACTIONS = Object.freeze([
  "sms",
  "staff_then_sms",
]);

const PRESET_POLICIES = Object.freeze({
  disabled: Object.freeze({
    openHours: "sms",
    afterHours: "sms",
    voiceFailure: "sms",
  }),
  always: Object.freeze({
    openHours: "voice_ai",
    afterHours: "voice_ai",
    voiceFailure: "sms",
  }),
  after_hours: Object.freeze({
    openHours: "staff_then_sms",
    afterHours: "voice_ai",
    voiceFailure: "sms",
  }),
  overflow: Object.freeze({
    openHours: "staff_then_voice_ai",
    afterHours: "staff_then_voice_ai",
    voiceFailure: "sms",
  }),
});

const isRoutingAction = (value) => VOICE_ROUTING_ACTIONS.includes(value);
const isFailureAction = (value) => VOICE_FAILURE_ACTIONS.includes(value);

export const getPresetRoutingPolicy = (answerMode = "disabled") => ({
  ...(PRESET_POLICIES[answerMode] || PRESET_POLICIES.disabled),
});

export const inferAnswerMode = ({ voiceAiEnabled, routingPolicy }) => {
  if (!voiceAiEnabled) return "disabled";

  for (const mode of ["always", "after_hours", "overflow"]) {
    const preset = PRESET_POLICIES[mode];
    if (
      preset.openHours === routingPolicy?.openHours &&
      preset.afterHours === routingPolicy?.afterHours &&
      preset.voiceFailure === routingPolicy?.voiceFailure
    ) {
      return mode;
    }
  }

  return "custom";
};

export const normalizeRoutingPolicy = (business) => {
  const settings = business?.voiceSettings || {};
  const version = Number(settings.routingPolicyVersion || 0);
  const answerMode = [
    "after_hours",
    "overflow",
    "always",
    "disabled",
    "custom",
  ].includes(settings.answerMode)
    ? settings.answerMode
    : "disabled";

  // Existing businesses keep the exact legacy answer-mode semantics until
  // they save the new scenario policy. The version marker prevents Mongoose
  // defaults on old documents from silently changing live call behavior.
  const fallback = getPresetRoutingPolicy(answerMode);
  if (version < 1) return fallback;

  return {
    openHours: isRoutingAction(settings.routingPolicy?.openHours)
      ? settings.routingPolicy.openHours
      : fallback.openHours,
    afterHours: isRoutingAction(settings.routingPolicy?.afterHours)
      ? settings.routingPolicy.afterHours
      : fallback.afterHours,
    voiceFailure: isFailureAction(settings.routingPolicy?.voiceFailure)
      ? settings.routingPolicy.voiceFailure
      : fallback.voiceFailure,
  };
};

export const routingPolicyUsesVoiceAi = (routingPolicy) =>
  [routingPolicy?.openHours, routingPolicy?.afterHours].some((value) =>
    ["voice_ai", "staff_then_voice_ai"].includes(value),
  );

export const routingPolicyUsesStaff = (routingPolicy) =>
  [
    routingPolicy?.openHours,
    routingPolicy?.afterHours,
    routingPolicy?.voiceFailure,
  ].some((value) => String(value || "").startsWith("staff_then_"));

export const getVoiceHttpBaseUrl = () =>
  trimTrailingSlash(
    process.env.VOICE_HTTP_PUBLIC_URL ||
      process.env.API_PUBLIC_URL ||
      process.env.PUBLIC_API_URL ||
      "",
  );

export const getVoiceWebSocketUrl = () =>
  String(process.env.VOICE_WEBSOCKET_PUBLIC_URL || "").trim();


export const isPhase9ForcedRelayFailureEnabled = () => {
  const environment = String(
    process.env.APP_ENV || process.env.NODE_ENV || "development",
  ).toLowerCase();

  return (
    environment !== "production" &&
    process.env.PHASE9_ENABLE_LIVE_TEST_HOOKS === "true" &&
    process.env.PHASE9_FORCE_RELAY_FAILURE === "true"
  );
};

export const isConversationRelayConfigured = () =>
  /^https:\/\//i.test(getVoiceHttpBaseUrl()) &&
  /^wss:\/\//i.test(getVoiceWebSocketUrl()) &&
  Boolean(process.env.TWILIO_AUTH_TOKEN);

export const normalizeVoiceSettings = (business) => {
  const routingPolicy = normalizeRoutingPolicy(business);
  const voiceAiEnabled = Boolean(business?.features?.voiceAiEnabled);
  const persistedMode = business?.voiceSettings?.answerMode || "disabled";
  const answerMode =
    Number(business?.voiceSettings?.routingPolicyVersion || 0) >= 1
      ? inferAnswerMode({ voiceAiEnabled, routingPolicy })
      : persistedMode;

  return {
    voiceAiEnabled,
    answerMode,
    routingPolicyVersion: Number(
      business?.voiceSettings?.routingPolicyVersion || 0,
    ),
    routingPolicy,
    overflowRingSeconds: Math.min(
      60,
      Math.max(5, Number(business?.voiceSettings?.overflowRingSeconds) || 20),
    ),
    transferPhone:
      business?.voiceSettings?.transferPhone || business?.forwardingPhone || "",
    welcomeGreeting:
      business?.voiceSettings?.welcomeGreeting ||
      `Thanks for calling ${
        business?.businessName || "the business"
      }. How can I help you today?`,
    voiceName: business?.voiceSettings?.voiceName || "",
    // Recording is fail-closed. A legacy true value never changes TwiML.
    recordingEnabled: false,
    recordingSupported: VOICE_RECORDING_SUPPORTED,
    recordingPolicy: VOICE_RECORDING_POLICY,
  };
};

const absoluteActionUrl = (actionPath) => {
  const baseUrl = getVoiceHttpBaseUrl();
  const path = String(actionPath || "");
  return /^https:\/\//i.test(path) ? path : `${baseUrl}${path}`;
};

export const conversationRelayTwiml = ({
  business,
  voiceSessionId,
  actionPath = "/api/twilio/voice-complete",
}) => {
  const settings = normalizeVoiceSettings(business);
  const voiceAttribute = settings.voiceName
    ? ` voice="${escapeXml(settings.voiceName)}"`
    : "";

  return xml(
    `<Response><Connect action="${escapeXml(
      absoluteActionUrl(actionPath),
    )}"><ConversationRelay url="${escapeXml(
      getVoiceWebSocketUrl(),
    )}" welcomeGreeting="${escapeXml(
      settings.welcomeGreeting,
    )}" welcomeGreetingInterruptible="any" language="en-US"${voiceAttribute}><Parameter name="voiceSessionId" value="${escapeXml(
      voiceSessionId,
    )}" /><Parameter name="businessId" value="${escapeXml(
      business._id,
    )}" /></ConversationRelay></Connect></Response>`,
  );
};

export const dialTwiml = ({
  transferPhone,
  timeout,
  actionPath = "/api/twilio/voice-overflow",
}) =>
  xml(
    `<Response><Dial timeout="${Math.min(
      60,
      Math.max(5, Number(timeout) || 20),
    )}" answerOnBridge="true" action="${escapeXml(
      absoluteActionUrl(actionPath),
    )}" method="POST"><Number>${escapeXml(
      transferPhone,
    )}</Number></Dial></Response>`,
  );

export const sayTwiml = (message, { hangup = true } = {}) =>
  xml(
    `<Response><Say>${escapeXml(message)}</Say>${
      hangup ? "<Hangup/>" : ""
    }</Response>`,
  );

export const emptyTwiml = () => xml("<Response></Response>");

export default {
  VOICE_FAILURE_ACTIONS,
  VOICE_RECORDING_POLICY,
  VOICE_RECORDING_SUPPORTED,
  VOICE_ROUTING_ACTIONS,
  conversationRelayTwiml,
  dialTwiml,
  emptyTwiml,
  getPresetRoutingPolicy,
  getVoiceHttpBaseUrl,
  getVoiceWebSocketUrl,
  inferAnswerMode,
  isConversationRelayConfigured,
  isPhase9ForcedRelayFailureEnabled,
  normalizeRoutingPolicy,
  normalizeVoiceSettings,
  routingPolicyUsesStaff,
  routingPolicyUsesVoiceAi,
  sayTwiml,
};
