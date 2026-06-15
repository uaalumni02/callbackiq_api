import Joi from "joi";

const leadSchema = Joi.object({
  customerName: Joi.string().allow("").max(100).optional(),

  phone: Joi.string()
    .pattern(/^[0-9+\-().\s]{7,20}$/)
    .required(),

  email: Joi.string().email().allow("").optional(),

  serviceNeeded: Joi.string().min(2).max(200).required(),

  urgency: Joi.string()
    .valid("low", "medium", "high", "emergency")
    .default("medium"),

  address: Joi.string().allow("").max(300).optional(),

  preferredAppointmentTime: Joi.string().allow("").max(100).optional(),

  leadQualityScore: Joi.number().min(0).max(100).default(50),

  estimatedValue: Joi.number().min(0).default(0),

  status: Joi.string()
    .valid("new", "contacted", "booked", "lost", "spam")
    .default("new"),

  source: Joi.string()
    .valid("missed_call", "manual", "sms", "web", "other")
    .default("manual"),

  summary: Joi.string().allow("").max(1000).optional(),

  notes: Joi.string().allow("").max(2000).optional(),
});

export default leadSchema;
