import { VALID_INTENT_CATEGORIES, VALID_SENTIMENT_LABELS, VALID_URGENCY_LEVELS, STORED_ACTION_TYPES, VALID_ACTION_PRIORITIES } from "../../services/conversationIntelligence.contract.js";
const ANALYSIS_STATUSES = ["pending", "processing", "completed", "failed"];

const LIKELIHOOD_LEVELS = ["very_low", "low", "medium", "high", "very_high"];

export const isValidAnalysisStatus = (value) =>
  ANALYSIS_STATUSES.includes(value);

export const isValidIntentCategory = (value) =>
  VALID_INTENT_CATEGORIES.includes(value);

export const isValidSentiment = (value) => VALID_SENTIMENT_LABELS.includes(value);

export const isValidLikelihoodLevel = (value) =>
  LIKELIHOOD_LEVELS.includes(value);

export const isValidUrgency = (value) => VALID_URGENCY_LEVELS.includes(value);

export const isValidActionType = (value) => STORED_ACTION_TYPES.includes(value);

export const isValidActionPriority = (value) =>
  VALID_ACTION_PRIORITIES.includes(value);
