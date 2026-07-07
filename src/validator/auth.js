import Joi from "joi";

const registerSchema = Joi.object({
  userName: Joi.string()
    .regex(/^[A-Za-z0-9]+([,'\-\.]?[ ]?[A-Za-z0-9]+)*$/)
    .min(3)
    .max(30)
    .required(),

  email: Joi.string().email().min(3).max(100).required(),

  password: Joi.string()
    .min(6)
    .max(50)
    .pattern(/^[\w@!$%*?&-]*$/)
    .required(),

  role: Joi.string().valid("owner", "admin", "member").default("owner"),

  businessName: Joi.string().min(2).max(100).required(),

  businessPhone: Joi.string().min(7).max(30).required(),

  businessType: Joi.string()
    .valid("hvac", "plumbing", "roofing", "electrical", "restoration", "other")
    .default("other"),

  smsConsent: Joi.boolean().valid(true).required().messages({
    "any.only": "SMS consent is required",
    "any.required": "SMS consent is required",
  }),

  termsAccepted: Joi.boolean().valid(true).required().messages({
    "any.only": "Terms of Service acceptance is required",
    "any.required": "Terms of Service acceptance is required",
  }),

  privacyAccepted: Joi.boolean().valid(true).required().messages({
    "any.only": "Privacy Policy acceptance is required",
    "any.required": "Privacy Policy acceptance is required",
  }),
});

const loginSchema = Joi.object({
  login: Joi.string().required(),
  password: Joi.string().required(),
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
