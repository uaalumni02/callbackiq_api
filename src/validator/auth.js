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

  businessPhone: Joi.string().allow("").max(30),

  businessType: Joi.string()
    .valid("hvac", "plumbing", "roofing", "electrical", "restoration", "other")
    .default("other"),
});

const loginSchema = Joi.object({
  login: Joi.string().required(),
  password: Joi.string().required(),
});

export { registerSchema, loginSchema };
