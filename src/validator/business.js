
import Joi from "joi";

const phonePattern = /^[0-9+\-().\s]{7,20}$/;

const ownerEditableFeaturesSchema = Joi.object({
  missedCallSmsEnabled: Joi.boolean().optional(),
  aiQualificationEnabled: Joi.boolean().optional(),
}).unknown(false);

const commonBusinessFields = {
  businessName: Joi.string().trim().min(2).max(100),

  businessType: Joi.string().valid(
    "hvac",
    "plumbing",
    "roofing",
    "electrical",
    "restoration",
    "other",
  ),

  // Twilio / CallBackIQ tracking number
  phone: Joi.string().pattern(phonePattern),

  // Real business/cell number calls should forward to
  forwardingPhone: Joi.string().pattern(phonePattern).allow(""),

  email: Joi.string().email().allow(""),

  website: Joi.string().trim().allow(""),

  address: Joi.string().trim().allow(""),

  city: Joi.string().trim().allow(""),

  state: Joi.string().trim().allow(""),

  zipCode: Joi.string().trim().allow(""),

  timezone: Joi.string().trim(),

  smsTemplate: Joi.string().trim().max(500).allow(""),

  estimatedJobValue: Joi.number().min(0),

  /*
   * Owners may control only Phase 0 features that are already implemented.
   * Unfinished feature flags remain server-controlled.
   */
  features: ownerEditableFeaturesSchema.optional(),
};

const businessCreateSchema = Joi.object({
  ...commonBusinessFields,

  businessName: commonBusinessFields.businessName.required(),

  businessType: commonBusinessFields.businessType.default("other"),

  phone: commonBusinessFields.phone.required(),

  timezone: commonBusinessFields.timezone.default("America/New_York"),

  estimatedJobValue: commonBusinessFields.estimatedJobValue.default(500),
}).unknown(false);

const businessUpdateSchema = Joi.object({
  ...commonBusinessFields,
})
  .min(1)
  .unknown(false);

export { businessCreateSchema, businessUpdateSchema };

export default businessCreateSchema;
