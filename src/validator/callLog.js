import Joi from "joi";

const callLogSchema = Joi.object({
  business: Joi.string().required(),

  lead: Joi.string().allow(null, "").optional(),

  conversation: Joi.string().allow(null, "").optional(),

  from: Joi.string()
    .pattern(/^[0-9+\-().\s]{7,20}$/)
    .required(),

  to: Joi.string()
    .pattern(/^[0-9+\-().\s]{7,20}$/)
    .required(),

  direction: Joi.string().valid("inbound", "outbound").default("inbound"),

  status: Joi.string()
    .valid("answered", "missed", "voicemail", "failed", "busy", "no_answer")
    .default("missed"),

  durationSeconds: Joi.number().min(0).default(0),

  provider: Joi.string().valid("manual", "twilio", "system").default("manual"),

  providerCallId: Joi.string().allow("").optional(),

  recordingUrl: Joi.string().allow("").optional(),

  transcription: Joi.string().allow("").optional(),

  missedCallTextSent: Joi.boolean().default(false),

  recovered: Joi.boolean().default(false),

  notes: Joi.string().allow("").max(2000).optional(),
});

export default callLogSchema;
