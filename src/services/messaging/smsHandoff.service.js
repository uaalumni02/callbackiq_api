import { respectCustomerConstraints, currentConstraints } from '../conversationCondition.service.js';
// CALLBACKIQ_SMS_PRODUCTION_HANDOFF_V1
// Delivery-safe human handoff helpers for production SMS conversations.
import {
  hasUnverifiedStaffCommitment,
  sanitizeUnverifiedStaffCommitments,
} from "../customerCommitmentSafety.service.js";

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

const HANDOFF_CATEGORIES = new Set([
  "hazardous_diy_request",
  "human_requested",
]);

// A high-priority service request is not automatically a 911-level emergency.
// Automation stops only for an explicit human request or a concrete safety flag.
const SAFETY_CATEGORIES = new Set(["hazardous_diy_request"]);
const IMMEDIATE_SAFETY_FLAGS = new Set([
  "safety_hazard",
  "hazardous_diy_request",
  "immediate_danger",
  "emergency_services",
]);

const EXPLICIT_CALLBACK_PATTERN =
  /\b(?:call me|call us|have (?:someone|a person|the team) call|can (?:someone|a person|the team) call|please call|phone me|ring me)\b/i;

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
    riskFlags.some((flag) => IMMEDIATE_SAFETY_FLAGS.has(String(flag || "")))
  );
};

const handoffReason = (result) => {
  if (["intake_complete", "intake_unclear", "scheduling_review"].includes(result?.handoff?.reason)) return result.handoff.reason;
  const category = clean(result?.messageCategory).toLowerCase();
  if (category) return category;
  const riskFlags = Array.isArray(result?.riskFlags) ? result.riskFlags : [];
  return clean(riskFlags[0]) || "human_takeover";
};

const businessName = (business) =>
  clean(business?.businessName) || "the business";

const callbackPhone = (conversation) =>
  clean(conversation?.customerPhone) || clean(conversation?.customerPhoneLookup);

export const requiresHumanHandoff = (result) => {
  const category = clean(result?.messageCategory).toLowerCase();
  const riskFlags = Array.isArray(result?.riskFlags) ? result.riskFlags : [];
  return (
    ["intake_complete", "intake_unclear", "scheduling_review"].includes(result?.handoff?.reason) ||
    HANDOFF_CATEGORIES.has(category) ||
    riskFlags.some((flag) => IMMEDIATE_SAFETY_FLAGS.has(String(flag || "")))
  );
};

const captured = value => {
  const text = clean(value);
  return text && !/^(?:unknown|not provided|not sure|skipped|n\/a)$/i.test(text);
};

// Completing manual intake is distinct from claiming a human accepted ownership.
export const shouldCompleteManualIntake = ({ business, lead, conversation, result }) =>
  business?.features?.aiBookingEnabled !== true &&
  conversation?.humanTakeover !== true &&
  !conversation?.orchestration?.handoffReason &&
  !["closed", "archived"].includes(conversation?.status) &&
  !["offering_slots", "awaiting_confirmation", "booking", "pending_business_confirmation", "booked"].includes(conversation?.bookingState?.status) &&
  result?.intakeReady !== false &&
  result?.decision !== "no_reply" &&
  result?.guardrail?.usedFallback !== true &&
  !requiresHumanHandoff(result) &&
  ["service_request", "appointment_preference", "availability_inquiry", "unknown"].includes(result?.messageCategory) &&
  Boolean(captured(lead?.serviceNeeded) && captured(lead?.address) && captured(lead?.preferredAppointmentTime) && captured(lead?.urgency));

export const buildCompletedIntakeResult = ({ result, business }) => ({
  ...result,
  decision: "send_fixed_response",
  actionType: "human_handoff",
  reply: result?.intakeCompletionReply || `Your service request is saved for ${businessName(business)} to review. The appointment needs business confirmation before a visit.`,
  handoff: { required: true, reason: "intake_complete", callbackRequested: false },
});

export const isUrgentOperationalResult = (result = {}) => {
  if (requiresHumanHandoff(result)) return false;
  const category = clean(result?.messageCategory).toLowerCase();
  const urgency = clean(result?.urgency).toLowerCase();
  return category === "emergency" || ["high", "emergency"].includes(urgency);
};

export const ensureUrgentOperationalResult = ({
  result = {},
  business,
  lead = {},
  conversation = {},
  customerMessage = "",
}) => {
  const rawReply = clean(result?.reply);
  const unsafe = hasUnverifiedStaffCommitment(rawReply);
  // Priority controls staff routing, not a paragraph appended to every turn.
  // Intake and safety policy already selected the appropriate next action.
  const fallback = !clean(result?.address || lead?.address)
    ? "What is the service address?"
    : "What day or time would you prefer? The business must confirm the appointment.";
  const reply = respectCustomerConstraints(
    unsafe || !rawReply ? fallback : sanitizeUnverifiedStaffCommitments(rawReply, { channel: 'sms' }),
    { conversation, customerMessage },
  );

  return {
    ...result,
    customerConstraints: currentConstraints(conversation),
    reply,
    shouldAlertOwner: true,
    alertPriority: "high",
    alertTitle: "Urgent customer request",
    alertMessage:
      "Review the latest SMS. CallBackIQ is continuing the customer conversation unless a person explicitly takes over.",
  };
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

  if (hasSafetyRisk(result)) {
    const guidance = respectCustomerConstraints(result.reply, { conversation, customerMessage });
    return guidance || `Avoid the affected area. For immediate danger, leave and call 911. Do not wait for a business callback.`;
  }

  const opening = explicitCallback
    ? `I've sent your callback request to ${name} at the number you're texting from.`
    : `I've flagged your request for ${name}.`;

  return `${opening}${details} I can't guarantee when someone will be available. I can keep helping here until a person takes over.`;
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
  const safety = hasSafetyRisk(result);
  const needsCombinedReply =
    safety ||
    explicitCallback ||
    !originalReply ||
    result?.decision === "no_reply";
  const reply = sanitizeUnverifiedStaffCommitments(
    needsCombinedReply
      ? buildHumanHandoffAcknowledgement({
          business,
          lead,
          conversation,
          result,
          customerMessage,
        })
      : originalReply,
    { channel: "sms" },
  );
  const reason = handoffReason(result);

  return {
    ...result,
    customerConstraints: currentConstraints(conversation),
    decision: "send_fixed_response",
    actionType: "human_handoff",
    messageCategory:
      clean(result?.messageCategory).toLowerCase() || "human_requested",
    reply,
    shouldAlertOwner: true,
    alertPriority: safety ? "critical" : "high",
    alertTitle:
      safety ? "Urgent review required" : reason === "intake_complete" ? "Service request ready for team review" : "Customer requested human follow-up",
    alertMessage: reason === "intake_complete"
      ? "Intake is complete. Review the service details and preferred time; automated intake is paused while the request waits for staff."
      : "Review the latest SMS and take ownership if available. CallBackIQ remains active until a person explicitly takes over.",
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

export const buildHumanHandoffStatusResult = ({ business, conversation }) => ({
  decision: "send_fixed_response",
  actionType: "human_handoff_status",
  messageCategory: "human_handoff_status",
  reply: conversation?.orchestration?.handoffReason === "intake_complete"
    ? "Your service request is saved for team review. The appointment is not confirmed, and I don’t have a confirmation timeframe."
    : buildHumanHandoffStatusAcknowledgement({ business }),
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
  "orchestration.phase": "handoff_pending",
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
  // Delivery of an acknowledgement is not proof that a staff member accepted
  // ownership. Keep automation eligible until a real staff action occurs.
  // The pending phase was recorded before delivery; do not overwrite a
  // concurrent real staff takeover that may happen while sending.
  "bookingState.escalatedAt": now,
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
  `Yes—your request was received and is flagged for ${businessName(
    business,
  )}. I can't guarantee when someone will be available to call. I can continue helping here. Any requested appointment time remains unconfirmed until the business confirms it.`;

export default {
  requiresHumanHandoff,
  isUrgentOperationalResult,
  ensureUrgentOperationalResult,
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
