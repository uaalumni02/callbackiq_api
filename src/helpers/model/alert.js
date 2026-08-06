export const ALERT_TYPES = new Set([
  /* Existing types retained for backward compatibility. */
  "hot_lead",
  "missed_call",
  "customer_reply",
  "booked_job",
  "system",
  /* Human intervention center types. */
  "safety_emergency",
  "human_requested",
  "angry_customer",
  "high_value_lead",
  "low_ai_confidence",
  "booking_conflict",
  "integration_failure",
  "message_delivery_failure",
  "unanswered_hot_lead",
  "appointment_canceled",
  "appointment_change_review",
]);

const ALERT_CHANNELS = new Set(["in_app", "email", "sms"]);
const ALERT_STATUSES = new Set([
  "pending",
  "sent",
  "failed",
  "read",
  "acknowledged",
  "resolved",
]);
const ALERT_PRIORITIES = new Set(["low", "medium", "high", "critical"]);

export const isValidAlertType = (value) => ALERT_TYPES.has(value);
export const isValidAlertChannel = (value) => ALERT_CHANNELS.has(value);
export const isValidAlertStatus = (value) => ALERT_STATUSES.has(value);
export const isValidAlertPriority = (value) => ALERT_PRIORITIES.has(value);
