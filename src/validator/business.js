import Joi from "joi";

const phonePattern = /^[0-9+\-().\s]{7,20}$/;

const businessSchema = Joi.object({
  businessName: Joi.string().min(2).max(100).required(),

  businessType: Joi.string()
    .valid("hvac", "plumbing", "roofing", "electrical", "restoration", "other")
    .default("other"),

  // Twilio / CallBackIQ tracking number
  phone: Joi.string().pattern(phonePattern).required(),

  // Real business/cell number calls should forward to
  forwardingPhone: Joi.string().pattern(phonePattern).allow("").optional(),

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
