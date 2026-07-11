import Joi from "joi";

const analyzeConversationSchema = Joi.object({
  force: Joi.boolean().default(false),
});

const feedbackSchema = Joi.object({
  rating: Joi.string()
    .valid("helpful", "partially_helpful", "not_helpful")
    .required(),

  correctedIntent: Joi.string().allow("").max(200).optional(),

  correctedUrgency: Joi.string()
    .valid("low", "normal", "high", "emergency", "unknown")
    .optional(),

  correctedEstimatedValue: Joi.number().min(0).optional(),

  notes: Joi.string().allow("").max(1000).optional(),
});

const actionSchema = Joi.object({
  completed: Joi.boolean().required(),

  outcome: Joi.string().allow("").max(1000).optional(),
});

const opportunityQuerySchema = Joi.object({
  minimumScore: Joi.number().min(0).max(100).default(70),

  minimumRevenue: Joi.number().min(0).default(0),

  urgency: Joi.string()
    .pattern(
      /^(low|normal|high|emergency|unknown)(,(low|normal|high|emergency|unknown))*$/,
    )
    .optional(),

  actionCompleted: Joi.boolean().optional(),

  limit: Joi.number().integer().min(1).max(100).default(25),

  page: Joi.number().integer().min(1).default(1),
});

const listQuerySchema = Joi.object({
  status: Joi.string()
    .valid("pending", "processing", "completed", "failed")
    .optional(),

  minimumScore: Joi.number().min(0).max(100).optional(),

  urgency: Joi.string()
    .valid("low", "normal", "high", "emergency", "unknown")
    .optional(),

  actionCompleted: Joi.boolean().optional(),

  limit: Joi.number().integer().min(1).max(100).default(25),

  page: Joi.number().integer().min(1).default(1),
});

export {
  analyzeConversationSchema,
  feedbackSchema,
  actionSchema,
  opportunityQuerySchema,
  listQuerySchema,
};
