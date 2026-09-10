import { BUSINESS_TYPES } from "../helpers/businessTypes.js";
import Joi from "joi";

const phonePattern = /^[0-9+\-().\s]{7,20}$/;

const ownerEditableFeaturesSchema = Joi.object({
  missedCallSmsEnabled: Joi.boolean().optional(),
  aiQualificationEnabled: Joi.boolean().optional(),
  aiBookingEnabled: Joi.boolean().optional(),
}).unknown(false);

const commonBusinessFields = {
  businessName: Joi.string().trim().min(2).max(100),

  businessType: Joi.string().valid(...BUSINESS_TYPES),

  // Create-only compatibility alias. Controllers must never persist this
  // owner-entered value into Business.phone.
  phone: Joi.string().pattern(phonePattern),
  forwardingPhone: Joi.string().pattern(phonePattern).allow(""),

  email: Joi.string().email().allow(""),

  website: Joi.string().trim().uri({ allowRelative: false }).allow(""),

  address: Joi.string().trim().max(200).allow(""),

  city: Joi.string().trim().max(100).allow(""),

  state: Joi.string().trim().max(100).allow(""),

  zipCode: Joi.string().trim().max(20).allow(""),

  timezone: Joi.string().trim().max(100),

  smsTemplate: Joi.string().trim().max(500).allow(""),
  estimatedJobValue: Joi.number().min(0).allow(null),

  features: ownerEditableFeaturesSchema.optional(),
};

const businessCreateSchema = Joi.object({
  ...commonBusinessFields,

  businessName: commonBusinessFields.businessName.required(),

  businessType: commonBusinessFields.businessType.default("other"),

  // At creation time a real forwarding destination is required, whether the
  // caller uses the new field or the legacy phone alias.
  forwardingPhone: Joi.string().pattern(phonePattern),

  timezone: commonBusinessFields.timezone.default("America/New_York"),
  estimatedJobValue: commonBusinessFields.estimatedJobValue.default(null),
})
  .or("forwardingPhone", "phone")
  .unknown(false);

const businessUpdateSchema = Joi.object({
  ...commonBusinessFields,
  // Tracking number is provisioned by CallBackIQ and cannot be owner-edited.
  phone: Joi.forbidden(),
})
  .min(1)
  .unknown(false);

export { businessCreateSchema, businessUpdateSchema };

export default businessCreateSchema;
