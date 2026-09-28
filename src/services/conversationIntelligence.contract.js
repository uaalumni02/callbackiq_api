// Shared analysis contract: provider schema, normalization, and persistence.
export const VALID_INTENT_CATEGORIES = [
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

export const VALID_SENTIMENT_LABELS = [
  "very_positive",
  "positive",
  "neutral",
  "concerned",
  "frustrated",
  "angry",
  "urgent",
  "unknown",
];

export const VALID_URGENCY_LEVELS = ["low", "normal", "high", "emergency", "unknown"];

export const VALID_ACTION_TYPES = [
  "call_now",
  "call_soon",
  "send_message",
  "prepare_estimate_for_review",
  "collect_appointment_preference",
  "request_appointment_confirmation",
  "request_information",
  "assign_team_member",
  "escalate",
  "follow_up_later",
  "close_lead",
  "none",
];

export const LEGACY_ACTION_TYPE_ALIASES = {
  send_estimate: "prepare_estimate_for_review",
  schedule_appointment: "request_appointment_confirmation",
};

export const VALID_ACTION_PRIORITIES = ["low", "medium", "high", "critical"];

export const VALID_OBJECTION_CATEGORIES = [
  "price",
  "availability",
  "trust",
  "timing",
  "comparison_shopping",
  "financing",
  "service_area",
  "other",
];

export const VALID_RISK_TYPES = [
  "angry_customer",
  "safety_hazard",
  "hazardous_diy_request",
  "possible_spam",
  "automation_loop",
  "legal_threat",
  "cancellation_risk",
  "competitor_comparison",
  "payment_concern",
  "sensitive_data",
  "privacy_concern",
  "service_area_issue",
  "prompt_injection",
  "off_topic",
  "unverified_commitment",
  "other",
];

export const VALID_RISK_SEVERITIES = ["low", "medium", "high", "critical"];

// Retain old stored classifications; new analyses emit only current actions.
export const STORED_ACTION_TYPES = [...VALID_ACTION_TYPES, ...Object.keys(LEGACY_ACTION_TYPE_ALIASES)];
export const ANALYSIS_TEXT_LIMITS = Object.freeze({summary:2000, intent:200, explanation:500, action:1000, suggestedMessage:1500});
