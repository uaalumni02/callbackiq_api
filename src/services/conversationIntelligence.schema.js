import { VALID_INTENT_CATEGORIES, VALID_SENTIMENT_LABELS, VALID_URGENCY_LEVELS, VALID_ACTION_TYPES, VALID_ACTION_PRIORITIES, VALID_OBJECTION_CATEGORIES, VALID_RISK_TYPES, VALID_RISK_SEVERITIES } from "./conversationIntelligence.contract.js";

export const conversationIntelligenceSchema = {
  type: "object",
  additionalProperties: false,

  properties: {
    summary: {
      type: "string",
    },

    customerIntent: {
      type: "object",
      additionalProperties: false,

      properties: {
        primary: {
          type: "string",
        },

        category: {
          type: "string",
          enum: VALID_INTENT_CATEGORIES,
        },

        serviceType: {
          type: "string",
        },
      },

      required: ["primary", "category", "serviceType"],
    },

    sentiment: {
      type: "object",
      additionalProperties: false,

      properties: {
        label: {
          type: "string",
          enum: VALID_SENTIMENT_LABELS,
        },

        score: {
          type: "number",
          minimum: -1,
          maximum: 1,
        },

        explanation: {
          type: "string",
        },
      },

      required: ["label", "score", "explanation"],
    },

    buyingLikelihood: {
      type: "object",
      additionalProperties: false,

      properties: {
        score: {
          type: "number",
          minimum: 0,
          maximum: 100,
        },

        reasons: {
          type: "array",

          items: {
            type: "string",
          },
        },
      },

      required: ["score", "reasons"],
    },

    appointmentProbability: {
      type: "object",
      additionalProperties: false,

      properties: {
        score: {
          type: "number",
          minimum: 0,
          maximum: 100,
        },

        reasons: {
          type: "array",

          items: {
            type: "string",
          },
        },
      },

      required: ["score", "reasons"],
    },

    urgency: {
      type: "object",
      additionalProperties: false,

      properties: {
        level: {
          type: "string",
          enum: VALID_URGENCY_LEVELS,
        },

        score: {
          type: "number",
          minimum: 0,
          maximum: 100,
        },

        reason: {
          type: "string",
        },
      },

      required: ["level", "score", "reason"],
    },

    estimatedRevenue: {
      type: "object",
      additionalProperties: false,

      properties: {
        minimum: {
          type: "number",
          minimum: 0,
        },

        maximum: {
          type: "number",
          minimum: 0,
        },

        likely: {
          type: "number",
          minimum: 0,
        },

        confidence: {
          type: "number",
          minimum: 0,
          maximum: 100,
        },

        basis: {
          type: "string",
        },
      },

      required: ["minimum", "maximum", "likely", "confidence", "basis"],
    },

    nextBestAction: {
      type: "object",
      additionalProperties: false,

      properties: {
        action: {
          type: "string",
        },

        actionType: {
          type: "string",
          enum: VALID_ACTION_TYPES,
        },

        priority: {
          type: "string",
          enum: VALID_ACTION_PRIORITIES,
        },

        recommendedWithinMinutes: {
          anyOf: [
            {
              type: "number",
              minimum: 0,
            },
            {
              type: "null",
            },
          ],
        },

        suggestedMessage: {
          type: "string",
        },
      },

      required: [
        "action",
        "actionType",
        "priority",
        "recommendedWithinMinutes",
        "suggestedMessage",
      ],
    },

    objections: {
      type: "array",

      items: {
        type: "object",
        additionalProperties: false,

        properties: {
          category: {
            type: "string",
            enum: VALID_OBJECTION_CATEGORIES,
          },

          description: {
            type: "string",
          },
        },

        required: ["category", "description"],
      },
    },

    missingInformation: {
      type: "array",

      items: {
        type: "string",
      },
    },

    riskFlags: {
      type: "array",

      items: {
        type: "object",
        additionalProperties: false,

        properties: {
          type: {
            type: "string",
            enum: VALID_RISK_TYPES,
          },

          severity: {
            type: "string",
            enum: VALID_RISK_SEVERITIES,
          },

          explanation: {
            type: "string",
          },
        },

        required: ["type", "severity", "explanation"],
      },
    },

    overallConfidence: {
      type: "number",
      minimum: 0,
      maximum: 100,
    },
  },

  required: [
    "summary",
    "customerIntent",
    "sentiment",
    "buyingLikelihood",
    "appointmentProbability",
    "urgency",
    "estimatedRevenue",
    "nextBestAction",
    "objections",
    "missingInformation",
    "riskFlags",
    "overallConfidence",
  ],
};
