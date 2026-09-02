const clean = (value) => String(value || "").trim();

export const SMS_CONVERSATION_PHASES = [
  "recovering",
  "qualifying",
  "collecting_location",
  "scheduling",
  "awaiting_customer_confirmation",
  "awaiting_business_approval",
  "confirmed",
  "post_booking",
  "human_takeover",
  "closed",
];

const BOOKING_TO_PHASE = new Map([
  ["not_started", "qualifying"],
  ["collecting_service", "qualifying"],
  ["collecting_location", "collecting_location"],
  ["collecting_street_address", "collecting_location"],
  ["collecting_postal_code", "collecting_location"],
  ["collecting_preference", "scheduling"],
  ["offering_slots", "scheduling"],
  ["awaiting_confirmation", "awaiting_customer_confirmation"],
  ["booking", "awaiting_customer_confirmation"],
  ["pending_business_confirmation", "awaiting_business_approval"],
  ["booked", "confirmed"],
  ["failed", "scheduling"],
  ["human_takeover", "human_takeover"],
]);

export const deriveSmsConversationPhase = (conversation, { hasCustomerReply = true } = {}) => {
  if (!conversation || ["closed", "archived"].includes(clean(conversation.status))) {
    return "closed";
  }
  if (conversation.humanTakeover === true || conversation.bookingState?.status === "human_takeover") {
    return "human_takeover";
  }
  const bookingStatus = clean(conversation.bookingState?.status);
  if (BOOKING_TO_PHASE.has(bookingStatus)) return BOOKING_TO_PHASE.get(bookingStatus);
  if (!hasCustomerReply) return "recovering";
  return clean(conversation.conversationMemory?.serviceNeeded) ? "qualifying" : "recovering";
};

export const buildSmsStatePatch = ({
  conversation,
  classification = null,
  outcome = null,
  now = new Date(),
  hasCustomerReply = true,
} = {}) => ({
  "orchestration.phase": deriveSmsConversationPhase(conversation, { hasCustomerReply }),
  "orchestration.lastIntent": classification?.primaryIntent || outcome?.intent || "",
  "orchestration.lastIntentConfidence": Math.round(
    Math.max(0, Math.min(100, Number(classification?.confidence || 0) * 100)),
  ),
  "orchestration.lastCustomerTurnAt": hasCustomerReply ? now : null,
  "orchestration.lastStateTransitionAt": now,
});

export default {
  SMS_CONVERSATION_PHASES,
  deriveSmsConversationPhase,
  buildSmsStatePatch,
};
