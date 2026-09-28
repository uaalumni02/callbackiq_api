import { VALID_INTENT_CATEGORIES, VALID_SENTIMENT_LABELS, VALID_URGENCY_LEVELS, STORED_ACTION_TYPES, VALID_ACTION_PRIORITIES, VALID_OBJECTION_CATEGORIES, VALID_RISK_TYPES, VALID_RISK_SEVERITIES, ANALYSIS_TEXT_LIMITS } from "../services/conversationIntelligence.contract.js";
import mongoose from "mongoose";

import * as validate from "../helpers/model/conversationIntelligence.js";

const { Schema } = mongoose;

const ConversationIntelligenceSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: [true, "Business is required"],
    },

    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: [true, "Conversation is required"],
      unique: true,
    },

    lead: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },

    analysisRequestId: { type: String, default: null },
    analysisLeaseExpiresAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      validate: [validate.isValidAnalysisStatus, "Invalid intelligence status"],
    },

    summary: {
      type: String,
      trim: true,
      default: "",
      maxlength: ANALYSIS_TEXT_LIMITS.summary,
    },

    customerIntent: {
      primary: {
        type: String,
        trim: true,
        default: "Unknown",
        maxlength: ANALYSIS_TEXT_LIMITS.intent,
      },

      category: {
        type: String,
        enum: VALID_INTENT_CATEGORIES,
        default: "unknown",
        validate: [validate.isValidIntentCategory, "Invalid intent category"],
      },

      serviceType: {
        type: String,
        trim: true,
        default: "",
        maxlength: ANALYSIS_TEXT_LIMITS.intent,
      },
    },

    sentiment: {
      label: {
        type: String,
        enum: VALID_SENTIMENT_LABELS,
        default: "unknown",
        validate: [validate.isValidSentiment, "Invalid sentiment label"],
      },

      score: {
        type: Number,
        min: -1,
        max: 1,
        default: 0,
      },

      explanation: {
        type: String,
        trim: true,
        default: "",
        maxlength: ANALYSIS_TEXT_LIMITS.explanation,
      },
    },

    buyingLikelihood: {
      score: {
        type: Number,
        min: 0,
        max: 100,
        default: 0,
      },

      level: {
        type: String,
        enum: ["very_low", "low", "medium", "high", "very_high"],
        default: "very_low",
        validate: [validate.isValidLikelihoodLevel, "Invalid likelihood level"],
      },

      reasons: {
        type: [String],
        default: [],
      },
    },

    appointmentProbability: {
      score: {
        type: Number,
        min: 0,
        max: 100,
        default: 0,
      },

      reasons: {
        type: [String],
        default: [],
      },
    },

    urgency: {
      level: {
        type: String,
        enum: VALID_URGENCY_LEVELS,
        default: "unknown",
        validate: [validate.isValidUrgency, "Invalid intelligence urgency"],
      },

      score: {
        type: Number,
        min: 0,
        max: 100,
        default: 0,
      },

      reason: {
        type: String,
        trim: true,
        default: "",
        maxlength: ANALYSIS_TEXT_LIMITS.explanation,
      },
    },

    estimatedRevenue: {
      source: { type: String, default: "legacy_unverified" },
      minimum: {
        type: Number,
        min: 0,
        default: null,
      },

      maximum: {
        type: Number,
        min: 0,
        default: null,
      },

      likely: {
        type: Number,
        min: 0,
        default: null,
      },

      currency: {
        type: String,
        trim: true,
        uppercase: true,
        default: "USD",
        maxlength: 3,
      },

      confidence: {
        type: Number,
        min: 0,
        max: 100,
        default: 0,
      },

      basis: {
        type: String,
        trim: true,
        default: "",
        maxlength: ANALYSIS_TEXT_LIMITS.explanation,
      },
    },

    nextBestAction: {
      action: {
        type: String,
        trim: true,
        default: "",
        maxlength: 1000,
      },

      actionType: {
        type: String,
        enum: STORED_ACTION_TYPES,
        default: "none",
        validate: [
          validate.isValidActionType,
          "Invalid recommended action type",
        ],
      },

      priority: {
        type: String,
        enum: VALID_ACTION_PRIORITIES,
        default: "medium",
        validate: [
          validate.isValidActionPriority,
          "Invalid recommended action priority",
        ],
      },

      recommendedWithinMinutes: {
        type: Number,
        min: 0,
        default: null,
      },

      suggestedMessage: {
        type: String,
        trim: true,
        default: "",
        maxlength: ANALYSIS_TEXT_LIMITS.suggestedMessage,
      },

      suggestedMessageGuardrail: {
        usedFallback: { type: Boolean, default: false },
        violations: { type: [String], default: [] },
      },

      completed: {
        type: Boolean,
        default: false,
      },

      completedAt: {
        type: Date,
        default: null,
      },

      outcome: {
        type: String,
        trim: true,
        default: "",
        maxlength: 1000,
      },
    },

    objections: [
      {
        category: {
          type: String,
          enum: VALID_OBJECTION_CATEGORIES,
          required: true,
        },

        description: {
          type: String,
          trim: true,
          required: true,
          maxlength: ANALYSIS_TEXT_LIMITS.explanation,
        },
      },
    ],

    missingInformation: {
      type: [String],
      default: [],
    },

    riskFlags: [
      {
        type: {
          type: String,
          enum: VALID_RISK_TYPES,
          required: true,
        },

        severity: {
          type: String,
          enum: VALID_RISK_SEVERITIES,
          required: true,
        },

        explanation: {
          type: String,
          trim: true,
          required: true,
          maxlength: ANALYSIS_TEXT_LIMITS.explanation,
        },
      },
    ],

    overallConfidence: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },

    sourceMessageCount: {
      type: Number,
      min: 0,
      default: 0,
    },

    lastMessageAnalyzedAt: {
      type: Date,
      default: null,
    },

    analysisVersion: {
      type: String,
      trim: true,
      default: "1.0",
      maxlength: 50,
    },

    modelUsed: {
      type: String,
      trim: true,
      default: "",
      maxlength: 100,
    },

    errorMessage: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1000,
    },

    feedback: {
      rating: {
        type: String,
        enum: ["helpful", "partially_helpful", "not_helpful", null],
        default: null,
      },

      correctedIntent: {
        type: String,
        trim: true,
        default: "",
        maxlength: ANALYSIS_TEXT_LIMITS.intent,
      },

      correctedUrgency: {
        type: String,
        enum: ["", "low", "normal", "high", "emergency", "unknown"],
        default: "",
      },

      correctedEstimatedValue: {
        type: Number,
        min: 0,
        default: null,
      },

      notes: {
        type: String,
        trim: true,
        default: "",
        maxlength: 1000,
      },

      submittedBy: {
        type: Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      submittedAt: {
        type: Date,
        default: null,
      },
    },
  },
  {
    timestamps: true,
  },
);

/*
 * Supports sorting and filtering by buying likelihood for one business.
 */
// Bounded owner read and related-record lookup indexes. Additive migration only.
ConversationIntelligenceSchema.index({ business: 1, lead: 1, createdAt: -1, _id: -1 });
ConversationIntelligenceSchema.index({ business: 1, conversation: 1, createdAt: -1, _id: -1 });
ConversationIntelligenceSchema.index({ business: 1, createdAt: -1, _id: -1 });
ConversationIntelligenceSchema.index({
  business: 1,
  "buyingLikelihood.score": -1,
});

/*
 * Supports sorting and filtering by urgency for one business.
 */
ConversationIntelligenceSchema.index({
  business: 1,
  "urgency.score": -1,
});

/*
 * Supports sorting and filtering by likely estimated revenue.
 */
ConversationIntelligenceSchema.index({
  business: 1,
  "estimatedRevenue.likely": -1,
});

/*
 * Supports pending, processing, completed, and failed analysis lists.
 */
ConversationIntelligenceSchema.index({
  business: 1,
  status: 1,
  updatedAt: -1,
});

/*
 * Supports the default newest-analysis list when no status is selected.
 */
ConversationIntelligenceSchema.index({
  business: 1,
  updatedAt: -1,
});

/*
 * Supports finding intelligence records related to a particular lead.
 */
ConversationIntelligenceSchema.index({
  business: 1,
  lead: 1,
  updatedAt: -1,
});

/*
 * Supports the high-priority opportunities and incomplete-action workflow.
 * The fields follow the expected filter and sorting order:
 *
 * business equality
 * action completion equality
 * urgency descending
 * buying likelihood descending
 * estimated revenue descending
 * latest analysis descending
 */
ConversationIntelligenceSchema.index({
  business: 1,
  "nextBestAction.completed": 1,
  "urgency.score": -1,
  "buyingLikelihood.score": -1,
  "estimatedRevenue.likely": -1,
  updatedAt: -1,
});

const ConversationIntelligence =
  mongoose.models.ConversationIntelligence ||
  mongoose.model("ConversationIntelligence", ConversationIntelligenceSchema);

export default ConversationIntelligence;
