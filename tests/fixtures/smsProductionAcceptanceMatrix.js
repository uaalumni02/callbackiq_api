// Fixed production acceptance matrix for customer-facing SMS behavior.
// Keep this between 75 and 150 representative cases. Add regressions here
// before changing production policy for a transcript that exposes a NEW class.

const trades = [
  { key: "plumbing", name: "Atlanta Pro Plumbing & Drain", service: "faucet replacement", address: "123 Pine Street Atlanta GA 30303" },
  { key: "hvac", name: "Metro HVAC", service: "air conditioner repair", address: "200 Peachtree Street Atlanta GA 30303" },
  { key: "electrical", name: "City Electrical", service: "outlet repair", address: "45 Auburn Avenue Atlanta GA 30303" },
  { key: "roofing", name: "Peachtree Roofing", service: "roof leak repair", address: "88 North Avenue Atlanta GA 30308" },
];

const tradeAt = (index) => trades[index % trades.length];
const baseBusiness = (trade) => ({
  businessName: trade.name,
  timezone: "America/New_York",
  features: { aiBookingEnabled: false },
});
const baseLead = (trade) => ({
  serviceNeeded: trade.service,
  address: trade.address,
  preferredAppointmentTime: "Monday at 9:00 AM",
  urgency: "medium",
});
const openConversation = () => ({
  status: "open",
  bookingState: { status: "not_started" },
  conversationMemory: {},
  orchestration: {},
});

const falseCommitmentReplies = [
  "You're booked for Monday at 9.",
  "You are scheduled for Monday morning.",
  "We've got you confirmed for Monday at 9.",
  "Your appointment is confirmed for Monday.",
  "Your visit has been scheduled for Monday.",
  "The service call is booked for Monday at 9.",
  "We will be there Monday at 9.",
  "A technician will arrive Monday morning.",
  "The technician can be there at 9.",
  "Someone will come out Monday morning.",
];

const falseCommitments = Array.from({ length: 20 }, (_, index) => {
  const trade = tradeAt(index);
  return {
    id: `false-commitment-${String(index + 1).padStart(2, "0")}`,
    category: "false_commitment",
    business: baseBusiness(trade),
    lead: baseLead(trade),
    conversation: openConversation(),
    customerMessage: "Monday at 9 works for me.",
    result: {
      decision: "send",
      messageCategory: "appointment_preference",
      reply: falseCommitmentReplies[index % falseCommitmentReplies.length],
    },
    expect: { requires: ["not confirmed"], forbids: ["you're booked", "you are scheduled", "appointment is confirmed", "will arrive", "will be there"] },
  };
});

const serviceReasks = Array.from({ length: 8 }, (_, index) => {
  const trade = tradeAt(index);
  return {
    id: `known-service-${String(index + 1).padStart(2, "0")}`,
    category: "known_fact_reask",
    business: baseBusiness(trade),
    lead: baseLead(trade),
    conversation: openConversation(),
    customerMessage: "Yes, that's right.",
    result: { decision: "send", messageCategory: "service_request", reply: "What service do you need help with?" },
    expect: { forbids: ["what service", "what do you need help with"] },
  };
});
const addressReasks = Array.from({ length: 6 }, (_, index) => {
  const trade = tradeAt(index + 1);
  return {
    id: `known-address-${String(index + 1).padStart(2, "0")}`,
    category: "known_fact_reask",
    business: baseBusiness(trade),
    lead: baseLead(trade),
    conversation: openConversation(),
    customerMessage: "That is correct.",
    result: { decision: "send", messageCategory: "service_request", reply: "What is the service address?" },
    expect: { forbids: ["what is the service address", "what's the service address"] },
  };
});
const timeReasks = Array.from({ length: 6 }, (_, index) => {
  const trade = tradeAt(index + 2);
  return {
    id: `known-time-${String(index + 1).padStart(2, "0")}`,
    category: "known_fact_reask",
    business: baseBusiness(trade),
    lead: baseLead(trade),
    conversation: openConversation(),
    customerMessage: "Monday at 9 works.",
    result: { decision: "send", messageCategory: "appointment_preference", reply: "What day and time work best for you?" },
    expect: { forbids: ["what day and time", "when works best"], unconfirmedAppointment: true },
  };
});

const unsupportedRequests = [
  "roof replacement",
  "tree removal",
  "garage door repair",
  "locksmith service",
  "pool repair",
  "appliance repair",
  "pest control",
  "concrete work",
];
const unsupported = Array.from({ length: 16 }, (_, index) => {
  const trade = tradeAt(index);
  const lead = baseLead(trade);
  lead.serviceNeeded = unsupportedRequests[index % unsupportedRequests.length];
  lead.serviceEligibility = { decision: "unsupported", request: lead.serviceNeeded };
  const conversation = openConversation();
  conversation.serviceEligibility = lead.serviceEligibility;
  return {
    id: `unsupported-${String(index + 1).padStart(2, "0")}`,
    category: "unsupported_service",
    business: baseBusiness(trade),
    lead,
    conversation,
    customerMessage: `Can you schedule ${lead.serviceNeeded} Monday?`,
    result: { decision: "send", messageCategory: "appointment_preference", reply: "Sure. What day and time work best for you?" },
    expect: { requires: ["not a service", "won't quote"], forbids: ["what day", "what time", "available monday"] },
  };
});

const staffReview = Array.from({ length: 12 }, (_, index) => {
  const trade = tradeAt(index);
  const lead = baseLead(trade);
  lead.serviceEligibility = { decision: "needs_staff_review", request: `${trade.service} with unusual access` };
  const conversation = openConversation();
  conversation.serviceEligibility = lead.serviceEligibility;
  return {
    id: `staff-review-${String(index + 1).padStart(2, "0")}`,
    category: "staff_review_boundary",
    business: baseBusiness(trade),
    lead,
    conversation,
    customerMessage: "Can you come Monday at 9 and what will it cost?",
    result: { decision: "send", messageCategory: index % 2 ? "pricing_request" : "appointment_preference", reply: "Monday at 9 should work. What time do you prefer and do you want an estimate?" },
    expect: { requires: ["staff review", "before pricing or scheduling"], unconfirmedAppointment: true, forbids: ["should work", "what time do you prefer"] },
  };
});

const priceScheduleMessages = [
  "How much does it cost and can you come Monday at 9am?",
  "What's the price and is Tuesday at 2 available?",
  "Can I get an estimate and come Wednesday morning?",
  "What will this cost? Thursday at 3 works for me.",
  "How much is the repair and can you do Friday at 10?",
];
const multiIntent = Array.from({ length: 20 }, (_, index) => {
  const trade = tradeAt(index);
  const lead = baseLead(trade);
  lead.preferredAppointmentTime = "";
  return {
    id: `price-schedule-${String(index + 1).padStart(2, "0")}`,
    category: "multi_intent",
    business: baseBusiness(trade),
    lead,
    conversation: openConversation(),
    customerMessage: priceScheduleMessages[index % priceScheduleMessages.length],
    result: { decision: "send", messageCategory: "service_request", reply: "I can help with that request." },
    expect: { requiresAny: [["price", "cost", "estimate", "quote"], ["preferred time", "request, not a confirmed appointment", "not confirmed", "availability", "needs to be checked"]] },
  };
});

const callbackMessages = [
  "Monday at 9 works. Please call me first.",
  "Tuesday afternoon is best and have someone call me.",
  "Wednesday at 10 is good. Can you call me before coming?",
];
const callbackSchedule = Array.from({ length: 12 }, (_, index) => {
  const trade = tradeAt(index);
  const lead = baseLead(trade);
  lead.preferredAppointmentTime = "";
  return {
    id: `callback-schedule-${String(index + 1).padStart(2, "0")}`,
    category: "callback_continuity",
    business: baseBusiness(trade),
    lead,
    conversation: openConversation(),
    customerMessage: callbackMessages[index % callbackMessages.length],
    result: { decision: "send", messageCategory: "appointment_preference", reply: "I have your service request." },
    expect: { requires: ["call"], requiresAny: [["preferred time", "not confirmed", "request, not a confirmed appointment", "availability", "needs to be checked"]] },
  };
});

const ambiguity = Array.from({ length: 10 }, (_, index) => {
  const trade = tradeAt(index);
  return {
    id: `ambiguity-${String(index + 1).padStart(2, "0")}`,
    category: "safe_ambiguity",
    business: baseBusiness(trade),
    lead: { serviceNeeded: "Unknown", urgency: "medium" },
    conversation: openConversation(),
    customerMessage: ["It does the thing again", "purple elephants", "not sure", "the same problem", "help"][index % 5],
    result: { decision: "send", messageCategory: "unknown", reply: "" },
    expect: { requires: ["don't want to guess"], forbids: ["booked", "confirmed for"] },
  };
});

const safety = Array.from({ length: 10 }, (_, index) => {
  const trade = tradeAt(index);
  return {
    id: `safety-dedupe-${String(index + 1).padStart(2, "0")}`,
    category: "safety_dedupe",
    business: baseBusiness(trade),
    lead: { ...baseLead(trade), urgency: "emergency" },
    conversation: openConversation(),
    customerMessage: "There is smoke and sparking right now.",
    result: {
      decision: "send_fixed_response",
      messageCategory: "emergency",
      reply: "For immediate danger, call 911. For immediate danger, call 911. Call 911 now if anyone is in immediate danger.",
      guardrail: { skipAI: true },
    },
    expect: { requires: ["911"], max911: 1 },
  };
});

const matrix = [
  ...falseCommitments,
  ...serviceReasks,
  ...addressReasks,
  ...timeReasks,
  ...unsupported,
  ...staffReview,
  ...multiIntent,
  ...callbackSchedule,
  ...ambiguity,
  ...safety,
];

export default matrix;
