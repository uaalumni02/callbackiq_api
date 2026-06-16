import Joi from "joi";

const qualifyLeadSchema = Joi.object({
  leadId: Joi.string().required(),

  messageBody: Joi.string().min(2).max(2000).required(),
});

export default qualifyLeadSchema;
