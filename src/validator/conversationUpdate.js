import Joi from 'joi';

export default Joi.object({
  business: Joi.string(),
  customerName: Joi.string().allow('').max(100),
  customerPhone: Joi.string().pattern(/^[0-9+\-().\s]{7,20}$/),
  lead: Joi.string().hex().length(24).allow(null, ''),
  status: Joi.string().valid('open', 'closed'),
  aiEnabled: Joi.boolean(),
  humanTakeover: Joi.boolean(),
}).min(1).unknown(false);
