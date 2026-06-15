import Joi from "joi";

const conversationSchema = Joi.object({
  lead: Joi.string().allow(null, "").optional(),

  customerPhone: Joi.string()
    .pattern(/^[0-9+\-().\s]{7,20}$/)
    .required(),

  customerName: Joi.string().allow("").max(100).optional(),

  status: Joi.string().valid("open", "closed", "spam").default("open"),
});

export default conversationSchema;
