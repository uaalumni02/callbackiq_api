export const VOICE_ROUTE = Object.freeze({
  LEGACY: "legacy",
  RELAY: "relay",
  DIAL_STAFF: "dial_staff",
  FALLBACK_SMS: "fallback_sms",
  COMPLETE: "complete",
});

export const VOICE_SCENARIO = Object.freeze({
  OPEN_HOURS: "open_hours",
  AFTER_HOURS: "after_hours",
  VOICE_FAILURE: "voice_failure",
});

export const POST_DIAL_FALLBACKS = Object.freeze(["voice_ai", "sms"]);

const validAction = (value) =>
  ["voice_ai", "sms", "staff_then_voice_ai", "staff_then_sms"].includes(
    value,
  )
    ? value
    : "sms";

export const getScenarioAction = ({ settings, isOpen }) =>
  validAction(
    isOpen === false
      ? settings?.routingPolicy?.afterHours
      : settings?.routingPolicy?.openHours,
  );

export const getScenarioName = (isOpen) =>
  isOpen === false ? VOICE_SCENARIO.AFTER_HOURS : VOICE_SCENARIO.OPEN_HOURS;

export const getPostDialFallback = (action) =>
  validAction(action).endsWith("voice_ai") ? "voice_ai" : "sms";

export const normalizePostDialFallback = (value) =>
  POST_DIAL_FALLBACKS.includes(value) ? value : "sms";

const routeForDirectAction = ({ action, transferPhone }) => {
  if (action === "voice_ai") return VOICE_ROUTE.RELAY;
  if (action === "sms") return VOICE_ROUTE.FALLBACK_SMS;
  if (transferPhone) return VOICE_ROUTE.DIAL_STAFF;
  return getPostDialFallback(action) === "voice_ai"
    ? VOICE_ROUTE.RELAY
    : VOICE_ROUTE.FALLBACK_SMS;
};

export const determineInitialVoiceRoute = ({ settings, isOpen = null }) => {
  if (!settings?.voiceAiEnabled || settings?.answerMode === "disabled") {
    return VOICE_ROUTE.LEGACY;
  }

  return routeForDirectAction({
    action: getScenarioAction({ settings, isOpen }),
    transferPhone: settings.transferPhone,
  });
};

export const determinePostDialVoiceRoute = ({
  dialStatus = "",
  fallback = "sms",
}) => {
  const status = String(dialStatus || "").trim().toLowerCase();
  if (["answered", "completed"].includes(status)) {
    return VOICE_ROUTE.COMPLETE;
  }

  return normalizePostDialFallback(fallback) === "voice_ai"
    ? VOICE_ROUTE.RELAY
    : VOICE_ROUTE.FALLBACK_SMS;
};

export const determineVoiceFailureRoute = ({ settings }) =>
  settings?.routingPolicy?.voiceFailure === "staff_then_sms" &&
  settings?.transferPhone
    ? VOICE_ROUTE.DIAL_STAFF
    : VOICE_ROUTE.FALLBACK_SMS;

export const buildOverflowActionPath = ({ action, scenario }) => {
  const params = new URLSearchParams({
    fallback: getPostDialFallback(action),
    scenario: scenario || VOICE_SCENARIO.OPEN_HOURS,
  });
  return `/api/twilio/voice-overflow?${params.toString()}`;
};

export const buildTransferActionPath = ({ reason = "human_handoff" } = {}) => {
  const params = new URLSearchParams({ fallback: "sms", reason });
  return `/api/twilio/voice-transfer-complete?${params.toString()}`;
};

export default {
  POST_DIAL_FALLBACKS,
  VOICE_ROUTE,
  VOICE_SCENARIO,
  buildOverflowActionPath,
  buildTransferActionPath,
  determineInitialVoiceRoute,
  determinePostDialVoiceRoute,
  determineVoiceFailureRoute,
  getPostDialFallback,
  getScenarioAction,
  getScenarioName,
  normalizePostDialFallback,
};
