import { normalizeEmergencyNumberForSpeech } from "./voiceSpeech.service.js";
import {
  normalizePhoneToE164,
  phoneNumbersEqual,
} from "./voicePhone.service.js";

const escapeXml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const trimTrailingSlash = (value) => String(value || "").trim().replace(/\/+$/, "");
const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

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

export const PRESET_POLICIES = Object.freeze({
  disabled: Object.freeze({
    openHours: "sms",
    afterHours: "sms",
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
  always: Object.freeze({
    openHours: "voice_ai",
    afterHours: "voice_ai",
    voiceFailure: "sms",
  }),
});

export const getPresetRoutingPolicy = (answerMode = "disabled") => ({
  ...(PRESET_POLICIES[answerMode] || PRESET_POLICIES.disabled),
});

export const normalizeRoutingPolicy = (value, answerMode = "disabled") => {
  const fallback = getPresetRoutingPolicy(answerMode);
  const source = value && typeof value === "object" ? value : {};
  const openHours = VOICE_ROUTING_ACTIONS.includes(source.openHours)
    ? source.openHours
    : fallback.openHours;
  const afterHours = VOICE_ROUTING_ACTIONS.includes(source.afterHours)
    ? source.afterHours
    : fallback.afterHours;
  const voiceFailure = VOICE_FAILURE_ACTIONS.includes(source.voiceFailure)
    ? source.voiceFailure
    : fallback.voiceFailure;
  return { openHours, afterHours, voiceFailure };
};

export const inferAnswerMode = (value) => {
  const voiceAiEnabled =
    value && typeof value === "object" && Object.hasOwn(value, "voiceAiEnabled")
      ? Boolean(value.voiceAiEnabled)
      : true;
  if (!voiceAiEnabled) return "disabled";
  const policy = value?.routingPolicy || value;
  const normalized = normalizeRoutingPolicy(policy, "disabled");
  for (const [mode, preset] of Object.entries(PRESET_POLICIES)) {
    if (
      preset.openHours === normalized.openHours &&
      preset.afterHours === normalized.afterHours &&
      preset.voiceFailure === normalized.voiceFailure
    ) {
      return mode;
    }
  }
  return "custom";
};

export const routingPolicyUsesVoiceAi = (policy) =>
  [policy?.openHours, policy?.afterHours].some((action) =>
    ["voice_ai", "staff_then_voice_ai"].includes(action),
  );

export const routingPolicyUsesStaff = (policy) =>
  [policy?.openHours, policy?.afterHours, policy?.voiceFailure].some((action) =>
    ["staff_then_voice_ai", "staff_then_sms"].includes(action),
  );

export const getVoiceHttpBaseUrl = () =>
  trimTrailingSlash(
    process.env.VOICE_HTTP_PUBLIC_URL ||
      process.env.TWILIO_WEBHOOK_BASE_URL ||
      "",
  );

export const getVoiceWebSocketUrl = () => {
  const configured = trimTrailingSlash(process.env.VOICE_WEBSOCKET_PUBLIC_URL);
  if (!configured) return "";
  if (/\/ws\/voice(?:\?.*)?$/i.test(configured)) return configured;
  return `${configured}/ws/voice`;
};

export const isConversationRelayConfigured = () =>
  /^wss:\/\//i.test(getVoiceWebSocketUrl()) &&
  /^https:\/\//i.test(getVoiceHttpBaseUrl()) &&
  Boolean(String(process.env.TWILIO_AUTH_TOKEN || "").trim());

export const getConversationRelayLanguage = () => {
  const configured = String(
    process.env.TWILIO_CONVERSATION_RELAY_LANGUAGE || "en-US",
  ).trim();

  return /^(?:en-US|es-US|multi)$/i.test(configured)
    ? configured
    : "en-US";
};

export const isPhase9ForcedRelayFailureEnabled = () => {
  const environment = String(
    process.env.APP_ENV || process.env.NODE_ENV || "",
  ).toLowerCase();
  if (environment === "production") return false;
  return (
    String(process.env.PHASE9_ENABLE_LIVE_TEST_HOOKS || "").toLowerCase() ===
      "true" &&
    String(process.env.PHASE9_FORCE_RELAY_FAILURE || "").toLowerCase() ===
      "true"
  );
};

const cleanGreeting = (value) => {
  const text = String(value || "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  // Treat the legacy generic default as unset so the business name is spoken.
  if (/^thanks for calling\.? how can i help you today\??$/i.test(text)) return "";
  return text.slice(0, 300);
};

const AI_DISCLOSURE_PATTERN = /\b(?:automated|virtual|ai)\s+(?:assistant|system|agent)\b/i;
export const ensureAutomatedAssistantDisclosure = (greeting, businessName = "") => {
  const name = String(businessName || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const fallback = name
    ? `Thanks for calling ${name}. This is their automated assistant. How can I help you today?`
    : "Thanks for calling. This is the automated assistant. How can I help you today?";
  const boundary = "This service does not monitor emergencies or dispatch emergency help. For immediate danger, call 911.";
  const cleaned = cleanGreeting(String(greeting || "").replaceAll(boundary, "").trim());
  const disclosed = !cleaned ? fallback : AI_DISCLOSURE_PATTERN.test(cleaned) ? cleaned : name
    ? `Thanks for calling ${name}. This is their automated assistant. ${cleaned}`
    : `This is the automated assistant. ${cleaned}`;
  return disclosed.includes(boundary) ? disclosed : `${disclosed} ${boundary}`;
};
const dynamicGreeting = (businessName) =>
  ensureAutomatedAssistantDisclosure("", businessName);

export const normalizeVoiceSettings = (business) => {
  const raw = business?.voiceSettings || {};
  const answerMode = ["after_hours", "overflow", "always", "disabled", "custom"].includes(
    raw.answerMode,
  )
    ? raw.answerMode
    : "disabled";
  const routingPolicy = normalizeRoutingPolicy(raw.routingPolicy, answerMode);
  const transferPhone = normalizePhoneToE164(
    raw.transferPhone || business?.forwardingPhone,
  );
  let liveTransferPhone = normalizePhoneToE164(raw.liveTransferPhone);
  const trackingPhone = normalizePhoneToE164(business?.phone);
  const liveTransferLoops = Boolean(
    liveTransferPhone &&
      phoneNumbersEqual(liveTransferPhone, trackingPhone),
  );
  if (liveTransferLoops) liveTransferPhone = "";

  const configuredWelcomeGreeting = cleanGreeting(raw.welcomeGreeting);
  const resolvedWelcomeGreeting =
    configuredWelcomeGreeting || dynamicGreeting(business?.businessName);

  return {
    voiceAiEnabled: Boolean(business?.features?.voiceAiEnabled),
    aiBookingEnabled: Boolean(business?.features?.aiBookingEnabled),
    trackingPhone,
    answerMode,
    routingPolicyVersion: 1,
    routingPolicy,
    overflowRingSeconds: boundedInteger(raw.overflowRingSeconds, 20, 15, 25),
    transferPhone,
    // Preserve the owner's enabled/disabled choice when the dedicated number is
    // merely missing so readiness can report the configuration blocker. Disable
    // only an actual routing loop, which must never be treated as usable.
    liveTransferEnabled: Boolean(raw.liveTransferEnabled && !liveTransferLoops),
    liveTransferPhone,
    configuredWelcomeGreeting,
    // Backward-compatible public field: callers and existing tests expect the
    // resolved business-identifying greeting here. The frontend uses
    // configuredWelcomeGreeting for the editable custom value.
    welcomeGreeting: resolvedWelcomeGreeting,
    resolvedWelcomeGreeting,
    voiceName: String(raw.voiceName || "").trim().slice(0, 80),
    recordingEnabled: false,
    recordingPolicy: VOICE_RECORDING_POLICY,
    maxCallDurationSeconds: boundedInteger(
      raw.maxCallDurationSeconds,
      600,
      60,
      600,
    ),
    maxConcurrentCalls: boundedInteger(raw.maxConcurrentCalls, 25, 1, 100),
    dailyVoiceMinutes: boundedInteger(
      raw.dailyVoiceMinutes,
      240,
      1,
      100000,
    ),
    monthlyVoiceMinutes: boundedInteger(
      raw.monthlyVoiceMinutes,
      4000,
      1,
      1000000,
    ),
    voiceHardCapEnabled: raw.voiceHardCapEnabled !== false,
    voiceOverageEnabled: raw.voiceOverageEnabled === true,
    voiceUsageWarningThresholds: Array.isArray(
      raw.voiceUsageWarningThresholds,
    )
      ? raw.voiceUsageWarningThresholds
      : [70, 85, 100],
    callerVelocityLimitPerHour: boundedInteger(
      raw.callerVelocityLimitPerHour,
      10,
      1,
      1000,
    ),
    agentConfirmationRequired: raw.agentConfirmationRequired !== false,
    answeringMachineDetectionEnabled:
      raw.answeringMachineDetectionEnabled !== false,
  };
};

export const emptyTwiml = () => xml("<Response></Response>");

export const sayTwiml = (message, { hangup = true, voice = "" } = {}) => {
  const voiceAttribute = voice ? ` voice="${escapeXml(voice)}"` : "";
  return xml(
    `<Response><Say${voiceAttribute}>${escapeXml(normalizeEmergencyNumberForSpeech(message))}</Say>${
      hangup ? "<Hangup/>" : ""
    }</Response>`,
  );
};

const appendQuery = (path, params = {}) => {
  const base = String(path || "");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && String(value) !== "") query.set(key, String(value));
  }
  if (!query.size) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${query.toString()}`;
};

export const conversationRelayTwiml = ({
  websocketUrl = getVoiceWebSocketUrl(),
  actionPath = "/api/twilio/voice-complete",
  greeting,
  businessName,
  business,
  voiceName,
  providerCallSid = "",
  voiceSessionId = "",
  businessId = "",
} = {}) => {
  const normalizedBusiness = business ? normalizeVoiceSettings(business) : null;
  const effectiveBusinessName =
    businessName || business?.businessName || "";
  const effectiveGreeting =
    greeting !== undefined
      ? greeting
      : normalizedBusiness?.welcomeGreeting || "";
  const resolvedGreeting = ensureAutomatedAssistantDisclosure(
    effectiveGreeting,
    effectiveBusinessName,
  );
  const effectiveVoiceName =
    voiceName !== undefined ? voiceName : normalizedBusiness?.voiceName || "";
  const effectiveBusinessId =
    businessId || business?._id?.toString?.() || business?._id || "";
  const action = appendQuery(actionPath, { callSid: providerCallSid });
  const voiceAttribute = effectiveVoiceName
    ? ` voice="${escapeXml(effectiveVoiceName)}"`
    : "";
  const parameters = [
    ["voiceSessionId", voiceSessionId],
    ["businessId", effectiveBusinessId],
    ["providerCallSid", providerCallSid],
  ]
    .filter(([, value]) => Boolean(value))
    .map(
      ([name, value]) =>
        `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}"/>`,
    )
    .join("");
  return xml(
    `<Response><Connect action="${escapeXml(action)}"><ConversationRelay url="${escapeXml(
      websocketUrl,
    )}" welcomeGreeting="${escapeXml(normalizeEmergencyNumberForSpeech(resolvedGreeting))}" language="${escapeXml(getConversationRelayLanguage())}" interruptible="any" interruptSensitivity="medium" dtmfDetection="true" reportInputDuringAgentSpeech="any" ignoreBackchannel="true" speechTimeout="1200"${voiceAttribute}>${parameters}</ConversationRelay></Connect></Response>`,
  );
};

export const dialTwiml = ({
  phone,
  timeoutSeconds = 20,
  actionPath = "/api/twilio/voice-overflow",
  screeningPath = "",
  providerCallSid = "",
} = {}) => {
  const normalizedPhone = normalizePhoneToE164(phone);
  if (!normalizedPhone) return sayTwiml("The staff line is not configured.");
  const timeout = boundedInteger(timeoutSeconds, 20, 15, 25);
  const action = appendQuery(actionPath, { callSid: providerCallSid });
  const screen = appendQuery(screeningPath, { callSid: providerCallSid });
  const numberAttributes = screen
    ? ` url="${escapeXml(screen)}" method="POST"`
    : "";
  return xml(
    `<Response><Dial action="${escapeXml(action)}" method="POST" timeout="${timeout}" answerOnBridge="true"><Number${numberAttributes}>${escapeXml(
      normalizedPhone,
    )}</Number></Dial></Response>`,
  );
};

export const staffScreenPromptTwiml = ({
  decisionPath = "/api/twilio/voice-staff-screen-decision",
  providerCallSid = "",
} = {}) => {
  const action = appendQuery(decisionPath, { callSid: providerCallSid });
  return xml(
    `<Response><Gather action="${escapeXml(action)}" method="POST" numDigits="1" timeout="7"><Say>CallBackIQ has a recovered customer call. Press 1 to accept.</Say></Gather><Gather action="${escapeXml(action)}" method="POST" numDigits="1" timeout="7"><Say>Still there? Press 1 now to accept the customer call.</Say></Gather><Hangup/></Response>`,
  );
};

export const staffScreenDecisionTwiml = ({ accepted = false } = {}) =>
  accepted
    ? xml("<Response><Say>Connecting the customer now.</Say></Response>")
    : xml("<Response><Hangup/></Response>");

export default {
  PRESET_POLICIES,
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
  staffScreenDecisionTwiml,
  staffScreenPromptTwiml,
};
