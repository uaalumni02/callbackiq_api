// CALLBACKIQ_SMS_PRODUCTION_HANDOFF_V1
// Delivery-safe human handoff helpers for production SMS conversations.

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

const HANDOFF_CATEGORIES = new Set([
  "emergency",
  "hazardous_diy_request",
  "human_requested",
]);

const SAFETY_CATEGORIES = new Set(["emergency", "hazardous_diy_request"]);

const EXPLICIT_CALLBACK_PATTERN =
  /\b(?:call me|call us|have (?:someone|a person|the team) call|can (?:someone|a person|the team) call|please call|phone me|ring me)\b/i;

const WATER_SAFETY_PATTERN =
  /\b(?:water|leak(?:ing)?|flood(?:ing)?|puddle|shut\s*off|water heater|pipe|sink|toilet)\b/i;

const HANDOFF_STATUS_PATTERNS = [
  /\b(?:did|has).{0,35}(?:callback|call back|request|message).{0,25}(?:go through|come through|arrive|send|sent|receive|received)\b/i,
  /\b(?:will|is|when).{0,25}(?:someone|a person|the team|staff).{0,20}(?:call|contact|respond|reply)\b/i,
  /\b(?:did you get (?:that|my message)|are you (?:still )?there|callback request)\b/i,
];

const DEFAULT_STATUS_REPLY_THROTTLE_MS = 10 * 60 * 1000;

const statusReplyThrottleMs = () => {
  const configuredMinutes = Number.parseInt(
    String(process.env.SMS_HANDOFF_STATUS_REPLY_THROTTLE_MINUTES || ""),
    10,
  );

  if (!Number.isFinite(configuredMinutes) || configuredMinutes < 1) {
    return DEFAULT_STATUS_REPLY_THROTTLE_MS;
  }

  return Math.min(60, configuredMinutes) * 60 * 1000;
};

const normalizeMessageId = (value) => {
  if (value == null) return "";
  if (typeof value === "object" && typeof value.toString === "function") {
    return value.toString();
  }
  return String(value);
};

const hasSafetyRisk = (result) => {
  const category = clean(result?.messageCategory).toLowerCase();
  const riskFlags = Array.isArray(result?.riskFlags) ? result.riskFlags : [];
  return (
    SAFETY_CATEGORIES.has(category) ||
    riskFlags.includes("safety_hazard") ||
    riskFlags.includes("hazardous_diy_request")
  );
};

const handoffReason = (result) => {
  const category = clean(result?.messageCategory).toLowerCase();
  if (category) return category;
  const riskFlags = Array.isArray(result?.riskFlags) ? result.riskFlags : [];
  return clean(riskFlags[0]) || "human_takeover";
};

const businessName = (business) =>
  clean(business?.businessName) || "the business";

const callbackPhone = (conversation) =>
  clean(conversation?.customerPhone) || clean(conversation?.customerPhoneLookup);

const isUrgent = ({ result, lead }) => {
  const urgency = clean(result?.urgency || lead?.urgency).toLowerCase();
  return hasSafetyRisk(result) || ["high", "emergency"].includes(urgency);
};

const shouldIncludeWaterSafety = ({ business, lead, customerMessage, result }) => {
  if (clean(business?.businessType).toLowerCase() !== "plumbing") return false;
  const context = [
    customerMessage,
    result?.serviceNeeded,
    lead?.serviceNeeded,
    result?.summary,
    lead?.summary,
  ]
    .map(clean)
    .join(" ");
  return WATER_SAFETY_PATTERN.test(context) && isUrgent({ result, lead });
};

export const requiresHumanHandoff = (result) => {
  const category = clean(result?.messageCategory).toLowerCase();
  const riskFlags = Array.isArray(result?.riskFlags) ? result.riskFlags : [];
  return (
    HANDOFF_CATEGORIES.has(category) ||
    riskFlags.includes("safety_hazard") ||
    riskFlags.includes("hazardous_diy_request")
  );
};

export const isHumanHandoffSource = ({ conversation, inboundMessageId }) => {
  const stored = normalizeMessageId(
    conversation?.orchestration?.handoffInboundMessage,
  );
  const incoming = normalizeMessageId(inboundMessageId);
  return Boolean(stored && incoming && stored === incoming);
};

export const isHumanHandoffStatusQuestion = (message) => {
  const text = clean(message);
  return Boolean(
    text && HANDOFF_STATUS_PATTERNS.some((pattern) => pattern.test(text)),
  );
};

export const shouldSendHumanHandoffStatusAcknowledgement = ({
  conversation,
  now = new Date(),
}) => {
  const lastReply = conversation?.orchestration?.handoffStatusReplyAt;
  if (!lastReply) return true;

  const lastReplyAt = new Date(lastReply).getTime();
  if (!Number.isFinite(lastReplyAt)) return true;
  return now.getTime() - lastReplyAt >= statusReplyThrottleMs();
};

export const buildHumanHandoffAcknowledgement = ({
  business,
  lead = {},
  conversation = {},
  result = {},
  customerMessage = "",
}) => {
  const name = businessName(business);
  const explicitCallback =
    clean(result?.messageCategory).toLowerCase() === "human_requested" ||
    EXPLICIT_CALLBACK_PATTERN.test(clean(customerMessage));
  const service = clean(result?.serviceNeeded || lead?.serviceNeeded);
  const details =
    service && service.toLowerCase() !== "unknown"
      ? ` I've shared the ${service.slice(0, 80)} details and urgency you provided.`
      : " I've shared the details and urgency you provided.";

  /*
   * Keep the urgent plumbing acknowledgement compact enough for normal SMS
   * delivery while preserving the callback promise and the highest-value
   * safety guidance. Do not provide repair instructions or imply diagnosis.
   */
  if (shouldIncludeWaterSafety({ business, lead, customerMessage, result })) {
    return `I've asked ${name} to call the number you're texting from and shared your details. Avoid using the fixture. Don't touch electrical equipment or stand in water. If you can safely identify and reach the correct shutoff, turn it off. For sparks, smoke, fire, or immediate danger, leave and call 911.`;
  }

  if (hasSafetyRisk(result)) {
    return `I've alerted ${name} and asked a team member to call the number you're texting from. Avoid the affected area. For immediate danger, leave and call 911.`;
  }

  const opening = explicitCallback
    ? `Absolutely. I've asked ${name} to call you at the number you're texting from.`
    : `I've alerted ${name} and asked a team member to follow up at the number you're texting from.`;

  return `${opening}${details} A team member will follow up as soon as possible.`;
};

export const ensureHumanHandoffResult = ({
  result = {},
  business,
  lead,
  conversation,
  customerMessage = "",
}) => {
  const originalReply = clean(result?.reply);
  const explicitCallback =
    clean(result?.messageCategory).toLowerCase() === "human_requested" ||
    EXPLICIT_CALLBACK_PATTERN.test(clean(customerMessage));
  const needsCombinedReply =
    explicitCallback || !originalReply || result?.decision === "no_reply";
  const reply = needsCombinedReply
    ? buildHumanHandoffAcknowledgement({
        business,
        lead,
        conversation,
        result,
        customerMessage,
      })
    : originalReply;
  const safety = hasSafetyRisk(result);
  const reason = handoffReason(result);

  return {
    ...result,
    decision: "send_fixed_response",
    actionType: "human_handoff",
    messageCategory:
      clean(result?.messageCategory).toLowerCase() || "human_requested",
    reply,
    shouldAlertOwner: true,
    alertPriority: safety ? "critical" : "high",
    alertTitle:
      safety ? "Urgent callback required" : "Customer requested a callback",
    alertMessage:
      "Review the latest SMS and call the customer at the texting number.",
    guardrail: {
      ...(result?.guardrail || {}),
      skipAI: true,
      reason: "sms_handoff_acknowledgement",
      usedFallback: needsCombinedReply,
    },
    handoff: {
      required: true,
      reason,
      callbackRequested: explicitCallback,
      callbackPhone: callbackPhone(conversation),
      acknowledgementRequired: true,
    },
  };
};

export const buildHumanHandoffStatusResult = ({ business }) => ({
  decision: "send_fixed_response",
  actionType: "human_handoff_status",
  messageCategory: "human_handoff_status",
  reply: buildHumanHandoffStatusAcknowledgement({ business }),
  shouldAlertOwner: false,
  alertPriority: "low",
  riskFlags: [],
  confidence: 100,
  guardrail: {
    skipAI: true,
    reason: "sms_handoff_status_acknowledgement",
    usedFallback: false,
    violations: [],
  },
  handoff: {
    required: false,
    statusAcknowledgement: true,
  },
});

export const buildPendingHumanHandoffUpdate = ({
  inboundMessageId,
  conversation,
  result,
  now = new Date(),
}) => ({
  "orchestration.handoffStatus": "pending_ack",
  "orchestration.handoffReason": handoffReason(result),
  "orchestration.handoffRequestedAt":
    conversation?.orchestration?.handoffRequestedAt || now,
  "orchestration.handoffAcknowledgedAt": null,
  "orchestration.handoffInboundMessage": inboundMessageId,
  "orchestration.handoffOutboundMessage": null,
  "orchestration.handoffCallbackPhone": callbackPhone(conversation),
  "orchestration.handoffLastError": "",
  "orchestration.lastEscalatedAt": now,
});

export const buildFailedHumanHandoffUpdate = ({
  inboundMessageId,
  conversation,
  result,
  error,
  now = new Date(),
}) => ({
  "orchestration.handoffStatus": "pending_ack",
  "orchestration.handoffReason": handoffReason(result),
  "orchestration.handoffRequestedAt":
    conversation?.orchestration?.handoffRequestedAt || now,
  "orchestration.handoffInboundMessage": inboundMessageId,
  "orchestration.handoffCallbackPhone": callbackPhone(conversation),
  "orchestration.handoffLastError": clean(error?.message || error).slice(0, 1000),
  "orchestration.lastEscalatedAt": now,
});

export const buildFinalizedHumanHandoffUpdate = ({
  inboundMessageId,
  outboundMessageId = null,
  conversation,
  result,
  deliveryStatus = "acknowledged",
  now = new Date(),
}) => ({
  aiEnabled: false,
  humanTakeover: true,
  humanTakeoverAt: now,
  humanTakeoverBy: null,
  "bookingState.status": "human_takeover",
  "bookingState.escalatedAt": now,
  "orchestration.phase": "human_takeover",
  "orchestration.lastOutcome": handoffReason(result),
  "orchestration.lastStateTransitionAt": now,
  "orchestration.lastEscalatedAt": now,
  "orchestration.lastAutomatedReplyAt":
    deliveryStatus === "acknowledged" ? now : null,
  "orchestration.lastInboundMessage": inboundMessageId,
  "orchestration.lastOutboundMessage": outboundMessageId,
  "orchestration.silentFailureCount": 0,
  "orchestration.handoffStatus": deliveryStatus,
  "orchestration.handoffReason": handoffReason(result),
  "orchestration.handoffRequestedAt":
    conversation?.orchestration?.handoffRequestedAt || now,
  "orchestration.handoffAcknowledgedAt":
    deliveryStatus === "acknowledged" ? now : null,
  "orchestration.handoffInboundMessage": inboundMessageId,
  "orchestration.handoffOutboundMessage": outboundMessageId,
  "orchestration.handoffCallbackPhone": callbackPhone(conversation),
  "orchestration.handoffLastError":
    deliveryStatus === "delivery_uncertain"
      ? "Provider accepted the attempt, but delivery confirmation is uncertain."
      : deliveryStatus === "suppressed"
        ? "The acknowledgement was suppressed by messaging-consent controls."
        : "",
});

export const buildHumanHandoffStatusAcknowledgement = ({ business }) =>
  `Yes—your message was received and your callback request is still with ${businessName(
    business,
  )}. A team member will contact you at the number you're texting from. Any requested appointment time remains unconfirmed until the team confirms it.`;

export default {
  requiresHumanHandoff,
  isHumanHandoffSource,
  isHumanHandoffStatusQuestion,
  shouldSendHumanHandoffStatusAcknowledgement,
  buildHumanHandoffAcknowledgement,
  ensureHumanHandoffResult,
  buildHumanHandoffStatusResult,
  buildPendingHumanHandoffUpdate,
  buildFailedHumanHandoffUpdate,
  buildFinalizedHumanHandoffUpdate,
  buildHumanHandoffStatusAcknowledgement,
};
