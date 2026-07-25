const ALERT_TYPES = new Set([
  "hot_lead",
  "missed_call",
  "customer_reply",
  "booked_job",
  "system",
]);

const ALERT_CHANNELS = new Set(["in_app", "email", "sms"]);
const ALERT_STATUSES = new Set(["pending", "sent", "failed", "read"]);
const ALERT_PRIORITIES = new Set(["low", "medium", "high", "critical"]);

export const isValidAlertType = (value) => {
  return ALERT_TYPES.has(value);
};

export const isValidAlertChannel = (value) => {
  return ALERT_CHANNELS.has(value);
};

export const isValidAlertStatus = (value) => {
  return ALERT_STATUSES.has(value);
};

export const isValidAlertPriority = (value) => {
  return ALERT_PRIORITIES.has(value);
};
