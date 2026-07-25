import Joi from "joi";

const ALERT_TYPES = [
  "hot_lead",
  "missed_call",
  "customer_reply",
  "booked_job",
  "system",
];

const ALERT_CHANNELS = ["in_app", "email", "sms"];
const ALERT_STATUSES = ["pending", "sent", "failed", "read"];
const ALERT_PRIORITIES = ["low", "medium", "high", "critical"];

const alertSchema = Joi.object({
  lead: Joi.string().hex().length(24).allow(null, "").optional(),

  type: Joi.string()
    .valid(...ALERT_TYPES)
    .required(),

  channel: Joi.string()
    .valid(...ALERT_CHANNELS)
    .default("in_app"),

  title: Joi.string().trim().min(2).max(120).required(),

  message: Joi.string().trim().min(2).max(1000).required(),

  status: Joi.string()
    .valid(...ALERT_STATUSES)
    .default("pending"),

  priority: Joi.string()
    .valid(...ALERT_PRIORITIES)
    .default("medium"),

  metadata: Joi.object().unknown(true).default({}),

  dedupeKey: Joi.string().trim().max(200).allow(null, "").optional(),
});

const updateAlertSchema = Joi.object({
  type: Joi.string()
    .valid(...ALERT_TYPES)
    .optional(),

  channel: Joi.string()
    .valid(...ALERT_CHANNELS)
    .optional(),

  title: Joi.string().trim().min(2).max(120).optional(),

  message: Joi.string().trim().min(2).max(1000).optional(),

  status: Joi.string()
    .valid(...ALERT_STATUSES)
    .optional(),

  priority: Joi.string()
    .valid(...ALERT_PRIORITIES)
    .optional(),

  metadata: Joi.object().unknown(true).optional(),
}).min(1);

export { alertSchema, updateAlertSchema };
