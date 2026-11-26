import Joi from "joi";

const checkoutSchema = Joi.object({
  plan: Joi.string().valid("pro").required(),
});

const webhookSchema = Joi.object({
  type: Joi.string().required(),
  data: Joi.object().required(),
}).unknown(true);

export { checkoutSchema, webhookSchema };
