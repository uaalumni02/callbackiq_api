import Joi from "joi";

export const demoOutreachAttemptSchema = Joi.object({
  channel: Joi.string().valid("phone", "email").required(),
});
