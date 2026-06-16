import Joi from "joi";

const agentReplySchema = Joi.object({
  conversationId: Joi.string().required(),

  leadId: Joi.string().allow(null, "").optional(),

  customerMessage: Joi.string().min(2).max(2000).required(),
});

export default agentReplySchema;
