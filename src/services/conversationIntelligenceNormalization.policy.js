// Pure analysis-output decisions. Configuration and guardrail results arrive explicitly.
import { VALID_INTENT_CATEGORIES, VALID_SENTIMENT_LABELS, VALID_URGENCY_LEVELS, VALID_ACTION_TYPES, LEGACY_ACTION_TYPE_ALIASES, VALID_ACTION_PRIORITIES, VALID_OBJECTION_CATEGORIES, VALID_RISK_TYPES, VALID_RISK_SEVERITIES, ANALYSIS_TEXT_LIMITS } from "./conversationIntelligence.contract.js";

const clamp = (value, minimum, maximum) => {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, numericValue));
};

const normalizePercentageScore = (value) => {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  // The structured-output contract specifies percentages, including 0 and 1.
  return Math.round(Math.min(100, Math.max(0, numericValue)));
};

export const cleanString = (value, fallback = "", maximum = ANALYSIS_TEXT_LIMITS.explanation) => {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.trim().slice(0, maximum);
};

const cleanStringArray = (value, maximumItems = 10) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === "string")
    .map((item) => cleanString(item))
    .filter(Boolean)
    .slice(0, maximumItems);
};

const enumValue = (value, allowedValues, fallback) => {
  return allowedValues.includes(value) ? value : fallback;
};

const normalizeActionType = (value) => {
  const mappedValue = LEGACY_ACTION_TYPE_ALIASES[value] || value;

  return enumValue(mappedValue, VALID_ACTION_TYPES, "none");
};

export const mapAnalysisActionToReplyAction = (actionType) => {
  if (actionType === "collect_appointment_preference") {
    return "collect_appointment_preference";
  }

  if (actionType === "request_information") {
    return "request_information";
  }

  return "acknowledge";
};

const getLikelihoodLevel = (score) => {
  if (score >= 90) {
    return "very_high";
  }

  if (score >= 75) {
    return "high";
  }

  if (score >= 50) {
    return "medium";
  }

  if (score >= 25) {
    return "low";
  }

  return "very_low";
};

const getUrgencyScore = (level, proposedScore) => {
  const score = normalizePercentageScore(proposedScore);

  if (proposedScore !== null && proposedScore !== undefined && Number.isFinite(Number(proposedScore))) {
    return score;
  }

  const fallbackScores = {
    emergency: 95,
    high: 80,
    normal: 50,
    low: 20,
    unknown: 0,
  };

  return fallbackScores[level] ?? 0;
};

const buildReadableAction = (action, actionType) => {
  const cleanedAction = cleanString(action, "", ANALYSIS_TEXT_LIMITS.action);

  /*
   * The AI may occasionally place the enum classification in the
   * human-readable action field. Replace it with a useful instruction.
   */
  if (
    cleanedAction &&
    cleanedAction !== actionType &&
    !VALID_ACTION_TYPES.includes(cleanedAction)
  ) {
    return cleanedAction;
  }

  const fallbackActions = {
    call_now: "Call the customer immediately and address the service request.",

    call_soon:
      "Call the customer as soon as possible to discuss the service request.",

    send_message: "Send the customer a professional follow-up message.",

    prepare_estimate_for_review:
      "Prepare an estimate for staff review before anything is sent or promised to the customer.",

    collect_appointment_preference:
      "Collect the customer's preferred day or time window without confirming an appointment.",

    request_appointment_confirmation:
      "Have the business contact the customer to confirm availability and finalize the appointment.",

    request_information:
      "Request the missing information needed to complete qualification and prepare for service.",

    assign_team_member:
      "Assign the lead to the appropriate team member for follow-up.",

    escalate: "Escalate the conversation for immediate review and follow-up.",

    follow_up_later:
      "Schedule a follow-up with the customer at the appropriate time.",

    close_lead:
      "Review the lead and close it if no additional follow-up is required.",

    none: "Review the conversation and determine the most appropriate next step.",
  };

  return fallbackActions[actionType] || fallbackActions.none;
};

export const prepareAnalysisNormalization = (analysis) => {
  const buyingScore = normalizePercentageScore(analysis?.buyingLikelihood?.score);
  const appointmentScore = normalizePercentageScore(analysis?.appointmentProbability?.score);
  const urgencyLevel = enumValue(analysis?.urgency?.level, VALID_URGENCY_LEVELS, "unknown");
  const actionType = normalizeActionType(analysis?.nextBestAction?.actionType);
  return { buyingScore, appointmentScore, urgencyLevel, actionType };
};

const filterAnalysisRisks = (analysis, sanitizedSuggestedMessage) => {
  const normalizedRiskFlags = Array.isArray(analysis?.riskFlags)
    ? analysis.riskFlags
        .filter((flag) => {
          return (
            flag &&
            VALID_RISK_TYPES.includes(flag.type) &&
            VALID_RISK_SEVERITIES.includes(flag.severity) &&
            cleanString(flag.explanation)
          );
        })
        .slice(0, 10)
        .map((flag) => ({
          type: flag.type,
          severity: flag.severity,
          explanation: cleanString(flag.explanation),
        }))
    : [];

  if (sanitizedSuggestedMessage.usedFallback) {
    normalizedRiskFlags.splice(9);
    normalizedRiskFlags.push({
      type: "unverified_commitment",
      severity: "medium",
      explanation: `The proposed customer message was replaced by an outbound guardrail: ${sanitizedSuggestedMessage.violations.join(", ")}.`,
    });
  }
  return normalizedRiskFlags.slice(0, 10);
};

const normalizeAnalysisIntent = (intent) => ({
  primary: cleanString(intent?.primary, "Unknown", ANALYSIS_TEXT_LIMITS.intent),
  category: enumValue(intent?.category, VALID_INTENT_CATEGORIES, "unknown"),
  serviceType: cleanString(intent?.serviceType, "", ANALYSIS_TEXT_LIMITS.intent),
});

const normalizeAnalysisSentiment = (sentiment) => ({
  label: enumValue(sentiment?.label, VALID_SENTIMENT_LABELS, "unknown"),
  // Sentiment intentionally remains on a -1 to 1 scale.
  score: clamp(sentiment?.score, -1, 1),
  explanation: cleanString(sentiment?.explanation),
});

const normalizeAnalysisNextAction = (action, actionType, sanitizedSuggestedMessage) => ({
  action: buildReadableAction(action?.action, actionType),
  actionType,
  priority: enumValue(action?.priority, VALID_ACTION_PRIORITIES, "medium"),
  recommendedWithinMinutes: action?.recommendedWithinMinutes === null
    ? null : Math.round(clamp(action?.recommendedWithinMinutes, 0, 43200)),
  suggestedMessage: cleanString(sanitizedSuggestedMessage.reply, "", ANALYSIS_TEXT_LIMITS.suggestedMessage),
  suggestedMessageGuardrail: {
    usedFallback: sanitizedSuggestedMessage.usedFallback,
    violations: sanitizedSuggestedMessage.violations,
  },
});

const filterAnalysisObjections = (objections) => Array.isArray(objections)
  ? objections
      .filter((objection) => {
        return (
          objection &&
          VALID_OBJECTION_CATEGORIES.includes(objection.category) &&
          cleanString(objection.description)
        );
      })
      .slice(0, 10)
      .map((objection) => ({
        category: objection.category,
        description: cleanString(objection.description),
      }))
  : [];

// Complete field normalization after the service has run the existing guardrail.
export const finalizeAnalysisNormalization = (analysis, prepared, sanitizedSuggestedMessage) => {
  const { buyingScore, appointmentScore, urgencyLevel, actionType } = prepared;
  const normalizedRiskFlags = filterAnalysisRisks(analysis, sanitizedSuggestedMessage);
  return {
    summary: cleanString(analysis?.summary, "", ANALYSIS_TEXT_LIMITS.summary),
    customerIntent: normalizeAnalysisIntent(analysis?.customerIntent),
    sentiment: normalizeAnalysisSentiment(analysis?.sentiment),
    buyingLikelihood: {
      score: buyingScore,
      level: getLikelihoodLevel(buyingScore),
      reasons: cleanStringArray(analysis?.buyingLikelihood?.reasons, 10),
    },
    appointmentProbability: {
      score: appointmentScore,
      reasons: cleanStringArray(analysis?.appointmentProbability?.reasons, 10),
    },
    urgency: {
      level: urgencyLevel,
      score: getUrgencyScore(urgencyLevel, analysis?.urgency?.score),
      reason: cleanString(analysis?.urgency?.reason),
    },
    estimatedRevenue: { minimum: null, maximum: null, likely: null, currency: "USD", confidence: 0, basis: "Not estimated" },
    nextBestAction: normalizeAnalysisNextAction(analysis?.nextBestAction, actionType, sanitizedSuggestedMessage),
    objections: filterAnalysisObjections(analysis?.objections),
    missingInformation: cleanStringArray(analysis?.missingInformation, 10),
    riskFlags: normalizedRiskFlags,
    overallConfidence: normalizePercentageScore(analysis?.overallConfidence),
    analysisVersion: "1.1",
  };
};

// The service resolves this only after all other fields, retaining per-call timing.
export const withAnalysisModel = (analysis, config) => ({ ...analysis, modelUsed: config.modelUsed });

export const validateMeaningfulAnalysis = (analysis) => {
  const errors = [];

  if (!analysis.summary) {
    errors.push("summary is missing");
  }

  if (!analysis.nextBestAction.action) {
    errors.push("next best action is missing");
  }

  if (errors.length > 0) {
    throw new Error(
      `AI conversation analysis was incomplete: ${errors.join(", ")}`,
    );
  }
};
