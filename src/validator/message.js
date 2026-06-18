import Joi from "joi";

const messageSchema = Joi.object({
  business: Joi.string().required(),

  conversation: Joi.string().required(),

  lead: Joi.string().allow(null, "").optional(),

  direction: Joi.string().valid("inbound", "outbound").required(),

  from: Joi.string()
    .pattern(/^[0-9+\-().\s]{7,20}$/)
    .required(),

  to: Joi.string()
    .pattern(/^[0-9+\-().\s]{7,20}$/)
    .required(),

  body: Joi.string().min(1).max(1600).required(),

  provider: Joi.string().valid("manual", "twilio", "system").default("manual"),

  providerMessageId: Joi.string().allow("").optional(),

  status: Joi.string()
    .valid("queued", "sent", "delivered", "failed", "received")
    .default("sent"),
});

export default messageSchema;
