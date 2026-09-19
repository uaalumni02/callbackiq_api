import Joi from "joi";
import { businessUpdateSchema } from "./business.js";
import { createServiceOfferingSchema, availabilityRulesSchema, createAvailabilityExceptionSchema,
  schedulingPolicySchema, serviceAreaSchema, operationsSettingsSchema } from "./businessConfiguration.js";
const id = Joi.string().hex().length(24);
export const ownerSettingsSchemas = {
  business: businessUpdateSchema.fork(["features", "smsTemplate", "estimatedJobValue"], s => s.forbidden()),
  services: Joi.object({
    services: Joi.array().items(createServiceOfferingSchema.keys({ _id: id })).max(300).required(),
    removedServiceIds: Joi.array().items(id).max(300).default([]),
    serviceArea: serviceAreaSchema.required(),
    serviceEligibilityPolicy: Joi.object({ catalogComplete: Joi.boolean().required(), excludedServices: Joi.array().items(Joi.string().trim().min(2).max(100)).max(50).required() }).required(),
  }),
  hours: Joi.object({
    rules: availabilityRulesSchema.extract("rules"),
    exceptions: Joi.array().items(createAvailabilityExceptionSchema.keys({ _id: id })).max(300).required(),
    removedExceptionIds: Joi.array().items(id).max(300).default([]),
    schedulingPolicy: schedulingPolicySchema.required(),
    bookingMode: Joi.string().valid("callback", "approval", "automatic").required(),
  }),
  calls: Joi.object({
    answerMode: Joi.string().valid("disabled", "after_hours", "overflow", "always", "custom").required(),
    transferPhone: Joi.string().allow("").max(30).required(),
    welcomeGreeting: Joi.string().allow("").max(300).required(),
    overflowRingSeconds: Joi.number().integer().min(15).max(25).required(),
    liveTransferEnabled: Joi.boolean().required(), liveTransferPhone: Joi.string().allow("").max(30).required(),
    smsTemplate: Joi.string().trim().max(500).allow("").required(),
    missedCallSmsEnabled: Joi.boolean().required(),
    automaticTextsEnabled: Joi.boolean().required(), voiceTextsEnabled: Joi.boolean().required(), appointmentTextsEnabled: Joi.boolean().required(),
  }),
  team: operationsSettingsSchema.fork(["aiPermissions", "followUpSettings", "serviceEligibilityPolicy"], s => s.forbidden()),
};
export const validateOwnerSection = (section, payload) => {
  const schema = ownerSettingsSchemas[section];
  if (!schema) { const e = new Error("Unknown settings section."); e.statusCode = 400; throw e; }
  return schema.validateAsync(payload, { abortEarly: false, convert: false });
};
