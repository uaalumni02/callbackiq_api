import Joi from "joi";

const conversationSchema = Joi.object({
  business: Joi.string().required(),

  lead: Joi.string().allow(null, "").optional(),

  customerPhone: Joi.string()
    .pattern(/^[0-9+\-().\s]{7,20}$/)
    .required(),

  customerName: Joi.string().allow("").max(100).optional(),

  // Conversations are archived only through POST /:id/archive so the
  // pre-archive state can be captured safely.
  status: Joi.string().valid("open", "closed").default("open"),

  aiEnabled: Joi.boolean().optional(),

  humanTakeover: Joi.boolean().optional(),

  lastMessage: Joi.string().allow("").optional(),

  lastMessageAt: Joi.date().optional(),
});

export default conversationSchema;
