import Joi from "joi";

export const demoOutreachAttemptSchema = Joi.object({
  channel: Joi.string().valid("phone", "email").required(),
});

export const demoOutreachEmailSchema = Joi.object({
  subject: Joi.string().trim().min(1).max(200).required(),
  body: Joi.string().trim().min(1).max(10000).required(),
});
