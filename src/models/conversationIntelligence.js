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
      maxlength: 2000,
    },

    customerIntent: {
      primary: {
        type: String,
        trim: true,
        default: "Unknown",
        maxlength: 200,
      },

      category: {
        type: String,
        enum: [
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
        ],
        default: "unknown",
        validate: [validate.isValidIntentCategory, "Invalid intent category"],
      },

      serviceType: {
        type: String,
        trim: true,
        default: "",
        maxlength: 200,
      },
    },

    sentiment: {
      label: {
        type: String,
        enum: [
          "very_positive",
          "positive",
          "neutral",
          "concerned",
          "frustrated",
          "angry",
          "urgent",
          "unknown",
        ],
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
        maxlength: 500,
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
        enum: ["low", "normal", "high", "emergency", "unknown"],
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
        maxlength: 500,
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
        maxlength: 500,
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
        enum: [
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
        ],
        default: "none",
        validate: [
          validate.isValidActionType,
          "Invalid recommended action type",
        ],
      },

      priority: {
        type: String,
        enum: ["low", "medium", "high", "critical"],
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
        maxlength: 1500,
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
          enum: [
            "price",
            "availability",
            "trust",
            "timing",
            "comparison_shopping",
            "financing",
            "service_area",
            "other",
          ],
          required: true,
        },

        description: {
          type: String,
          trim: true,
          required: true,
          maxlength: 500,
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
          enum: [
            "angry_customer",
            "safety_hazard",
            "possible_spam",
            "legal_threat",
            "cancellation_risk",
            "competitor_comparison",
            "payment_concern",
            "service_area_issue",
            "other",
          ],
          required: true,
        },

        severity: {
          type: String,
          enum: ["low", "medium", "high", "critical"],
          required: true,
        },

        explanation: {
          type: String,
          trim: true,
          required: true,
          maxlength: 500,
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
        maxlength: 200,
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
