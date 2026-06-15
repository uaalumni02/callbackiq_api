import Joi from "joi";

const businessSchema = Joi.object({
  businessName: Joi.string().min(2).max(100).required(),

  businessType: Joi.string()
    .valid("hvac", "plumbing", "roofing", "electrical", "restoration", "other")
    .default("other"),

  phone: Joi.string()
    .pattern(/^[0-9+\-().\s]{7,20}$/)
    .required(),

  email: Joi.string().email().allow("").optional(),

  website: Joi.string().allow("").optional(),

  address: Joi.string().allow("").optional(),

  city: Joi.string().allow("").optional(),

  state: Joi.string().allow("").optional(),

  zipCode: Joi.string().allow("").optional(),

  timezone: Joi.string().default("America/New_York"),

  smsTemplate: Joi.string().max(500).allow("").optional(),

  estimatedJobValue: Joi.number().min(0).default(500),
});

export default businessSchema;
