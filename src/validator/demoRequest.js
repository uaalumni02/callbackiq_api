import Joi from "joi";

export const demoRequestSchema = Joi.object({
  fullName: Joi.string().trim().min(2).max(100).required(),
  email: Joi.string().trim().email().required(),
  phone: Joi.string().trim().allow("").max(30),
  businessName: Joi.string().trim().min(2).max(120).required(),
  businessType: Joi.string().trim().allow("").max(80),
  website: Joi.string().trim().allow("").max(200),
  preferredTime: Joi.string().trim().allow("").max(120),
  message: Joi.string().trim().allow("").max(1000),
  source: Joi.string().trim().allow("").max(80),
});

export const updateDemoRequestSchema = Joi.object({
  status: Joi.string()
    .valid("new", "contacted", "scheduled", "closed", "spam")
    .optional(),

  adminNotes: Joi.string().trim().allow("").max(1500).optional(),
});
