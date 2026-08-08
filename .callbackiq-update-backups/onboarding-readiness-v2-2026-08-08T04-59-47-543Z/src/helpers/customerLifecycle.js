export const CUSTOMER_LIFECYCLE_STATUSES = [
  "new",
  "engaged",
  "qualified",
  "booking",
  "booked",
  "in_service",
  "recovered",
  "closed",
  "lost",
  "spam",
];

export const customerLifecycleField = {
  type: String,
  enum: CUSTOMER_LIFECYCLE_STATUSES,
  default: "new",
  index: true,
};

const ACTIVE_RANK = new Map(
  ["new", "engaged", "qualified", "booking", "booked", "in_service", "recovered"]
    .map((status, index) => [status, index]),
);

export const lifecycleFromLead = (lead = {}) => {
  if (lead.status === "spam") return "spam";
  if (lead.status === "lost") return "lost";
  if (lead.recovered || Number(lead.actualRevenue) > 0 || lead.completedAt) return "recovered";
  if (lead.status === "booked" || lead.bookedAt || lead.appointment) return "booked";
  if (lead.qualifiedAt) return "qualified";
  if (lead.status === "contacted" || lead.firstRespondedAt) return "engaged";
  return "new";
};

export const lifecycleFromConversation = (conversation = {}) => {
  const bookingStatus = conversation.bookingState?.status;
  if (bookingStatus === "booked") return "booked";
  if (
    [
      "collecting_service",
      "collecting_location",
      "collecting_street_address",
      "collecting_postal_code",
      "collecting_preference",
      "offering_slots",
      "awaiting_confirmation",
      "booking",
    ].includes(bookingStatus)
  ) {
    return "booking";
  }
  if (conversation.status === "closed" || conversation.status === "archived") return "closed";
  if (conversation.lastMessage || conversation.lastMessageAt) return "engaged";
  return "new";
};

export const lifecycleFromAppointment = (appointment = {}) => {
  if (appointment.status === "completed") return "recovered";
  if (appointment.status === "confirmed") return "booked";
  if (appointment.status === "held" || appointment.status === "rescheduled") return "booking";
  if (["canceled", "no_show", "failed"].includes(appointment.status)) return "closed";
  return "new";
};

export const lifecycleFromVoiceSession = (session = {}) => {
  if (session.outcome === "booked") return "booked";
  if (
    [
      "routing",
      "connecting",
      "active",
      "capturing_callback",
      "safety_escalated",
      "transferring",
      "completing",
    ].includes(session.status)
  ) {
    return "engaged";
  }
  if (["completed", "failed", "canceled"].includes(session.status)) return "closed";
  return "new";
};

export const deriveCanonicalLifecycle = ({
  lead,
  conversations = [],
  appointments = [],
  voiceSessions = [],
} = {}) => {
  const leadStatus = lifecycleFromLead(lead || {});
  if (["spam", "lost"].includes(leadStatus)) return leadStatus;

  const candidates = [
    leadStatus,
    ...conversations.map(lifecycleFromConversation),
    ...appointments.map(lifecycleFromAppointment),
    ...voiceSessions.map(lifecycleFromVoiceSession),
  ];
  if (candidates.includes("recovered")) return "recovered";

  return candidates.reduce((best, value) => {
    if (!ACTIVE_RANK.has(value)) return best;
    return (ACTIVE_RANK.get(value) ?? -1) > (ACTIVE_RANK.get(best) ?? -1)
      ? value
      : best;
  }, "new");
};
