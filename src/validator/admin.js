import Joi from "joi";

export const adminBusinessIdSchema = Joi.object({
  businessId: Joi.string().hex().length(24).required(),
});

export const adminSubscriptionStatusSchema = Joi.object({
  status: Joi.string()
    .valid(
      "incomplete",
      "trialing",
      "active",
      "past_due",
      "canceled",
      "unpaid",
      "paused",
      "none",
    )
    .required(),
});

export const adminBusinessStatusSchema = Joi.object({
  isActive: Joi.boolean().required(),
});
