import Joi from "joi";

const registerSchema = Joi.object({
  // userName is retained for compatibility with older clients. New trial
  // signup clients omit it and the controller generates an internal username.
  userName: Joi.string()
    .regex(/^[A-Za-z0-9]+([,'\-\.]?[ ]?[A-Za-z0-9]+)*$/)
    .min(3)
    .max(30)
    .optional(),

  email: Joi.string().email().min(3).max(100).required(),

  password: Joi.string()
    .min(6)
    .max(50)
    .pattern(/^[\w@!$%*?&-]*$/)
    .required(),

  role: Joi.string().valid("owner").default("owner"),
  businessName: Joi.string().min(2).max(100).required(),

  // Forwarding phone and business type now belong to onboarding. Both remain
  // accepted here so older registration clients keep working during rollout.
  forwardingPhone: Joi.string().min(7).max(30).optional(),
  businessPhone: Joi.string().min(7).max(30).optional(),
  businessType: Joi.string()
    .valid("hvac", "plumbing", "roofing", "electrical", "restoration", "other")
    .default("other"),

  smsConsent: Joi.boolean().default(false),
  termsAccepted: Joi.boolean().valid(true).required().messages({
    "any.only": "Terms of Service acceptance is required",
    "any.required": "Terms of Service acceptance is required",
  }),

  privacyAccepted: Joi.boolean().valid(true).required().messages({
    "any.only": "Privacy Policy acceptance is required",
    "any.required": "Privacy Policy acceptance is required",
  }),

  securityChallengeToken: Joi.string().trim().max(4096).allow("").optional(),
});

const loginSchema = Joi.object({
  login: Joi.string().trim().min(1).max(100).required(),

  password: Joi.string().min(1).max(200).required(),

  securityChallengeToken: Joi.string().trim().max(4096).allow("").optional(),
});

const requestPasswordResetSchema = Joi.object({
  email: Joi.string().email().min(3).max(100).required(),
});

const resetPasswordSchema = Joi.object({
  password: Joi.string()
    .min(6)
    .max(50)
    .pattern(/^[\w@!$%*?&-]*$/)
    .required(),
});

export {
  registerSchema,
  loginSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
};
