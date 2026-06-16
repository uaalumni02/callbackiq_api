import Joi from "joi";

const alertSchema = Joi.object({
  lead: Joi.string().allow(null, "").optional(),

  type: Joi.string()
    .valid("hot_lead", "missed_call", "booked_job", "system")
    .required(),

  channel: Joi.string().valid("in_app", "email", "sms").default("in_app"),

  title: Joi.string().min(2).max(120).required(),

  message: Joi.string().min(2).max(1000).required(),

  status: Joi.string()
    .valid("pending", "sent", "failed", "read")
    .default("pending"),

  priority: Joi.string().valid("low", "medium", "high").default("medium"),

  metadata: Joi.object().default({}),
});

const updateAlertSchema = Joi.object({
  type: Joi.string()
    .valid("hot_lead", "missed_call", "booked_job", "system")
    .optional(),

  channel: Joi.string().valid("in_app", "email", "sms").optional(),

  title: Joi.string().min(2).max(120).optional(),

  message: Joi.string().min(2).max(1000).optional(),

  status: Joi.string().valid("pending", "sent", "failed", "read").optional(),

  priority: Joi.string().valid("low", "medium", "high").optional(),

  metadata: Joi.object().optional(),
}).min(1);

export { alertSchema, updateAlertSchema };
