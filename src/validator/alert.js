import Joi from "joi";

import { ALERT_TYPES as ALERT_TYPE_SET } from "../helpers/model/alert.js";

const ALERT_TYPES = [...ALERT_TYPE_SET];
const ALERT_CHANNELS = ["in_app", "email", "sms"];
const ALERT_STATUSES = [
  "pending",
  "sent",
  "failed",
  "read",
  "acknowledged",
  "resolved",
];
const ALERT_PRIORITIES = ["low", "medium", "high", "critical"];

const objectId = Joi.string().hex().length(24);
const optionalObjectId = objectId.allow(null, "").optional();

const interventionFields = {
  conversation: optionalObjectId,
  appointment: optionalObjectId,
  assignedTo: optionalObjectId,
  acknowledgedAt: Joi.date().iso().allow(null).optional(),
  resolvedAt: Joi.date().iso().allow(null).optional(),
  resolution: Joi.string().trim().max(2000).allow("").optional(),
  actionRequired: Joi.boolean().optional(),
  dueAt: Joi.date().iso().allow(null).optional(),
  reason: Joi.string().trim().max(1000).allow("").optional(),
  recommendedAction: Joi.string().trim().max(1000).allow("").optional(),
  aiSummary: Joi.string().trim().max(2000).allow("").optional(),
  lastCustomerMessage: Joi.string().trim().max(1600).allow("").optional(),
};

const alertSchema = Joi.object({
  lead: optionalObjectId,
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
  ...interventionFields,
});

const updateAlertSchema = Joi.object({
  lead: optionalObjectId,
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
  dedupeKey: Joi.string().trim().max(200).allow(null, "").optional(),
  ...interventionFields,
}).min(1);

export { alertSchema, updateAlertSchema };
