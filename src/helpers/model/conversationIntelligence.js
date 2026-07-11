const ANALYSIS_STATUSES = ["pending", "processing", "completed", "failed"];

const INTENT_CATEGORIES = [
  "repair",
  "replacement",
  "maintenance",
  "inspection",
  "estimate",
  "emergency",
  "appointment",
  "support",
  "complaint",
  "cancellation",
  "other",
  "unknown",
];

const SENTIMENT_LABELS = [
  "very_positive",
  "positive",
  "neutral",
  "concerned",
  "frustrated",
  "angry",
  "urgent",
  "unknown",
];

const LIKELIHOOD_LEVELS = ["very_low", "low", "medium", "high", "very_high"];

const URGENCY_LEVELS = ["low", "normal", "high", "emergency", "unknown"];

const ACTION_TYPES = [
  "call_now",
  "call_soon",
  "send_message",
  "send_estimate",
  "schedule_appointment",
  "request_information",
  "assign_team_member",
  "escalate",
  "follow_up_later",
  "close_lead",
  "none",
];

const ACTION_PRIORITIES = ["low", "medium", "high", "critical"];

export const isValidAnalysisStatus = (value) =>
  ANALYSIS_STATUSES.includes(value);

export const isValidIntentCategory = (value) =>
  INTENT_CATEGORIES.includes(value);

export const isValidSentiment = (value) => SENTIMENT_LABELS.includes(value);

export const isValidLikelihoodLevel = (value) =>
  LIKELIHOOD_LEVELS.includes(value);

export const isValidUrgency = (value) => URGENCY_LEVELS.includes(value);

export const isValidActionType = (value) => ACTION_TYPES.includes(value);

export const isValidActionPriority = (value) =>
  ACTION_PRIORITIES.includes(value);
