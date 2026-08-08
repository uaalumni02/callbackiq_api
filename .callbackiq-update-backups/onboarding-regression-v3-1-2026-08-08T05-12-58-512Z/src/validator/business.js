import Joi from "joi";

const phonePattern = /^[0-9+\-().\s]{7,20}$/;

const ownerEditableFeaturesSchema = Joi.object({
  missedCallSmsEnabled: Joi.boolean().optional(),
  aiQualificationEnabled: Joi.boolean().optional(),
  aiBookingEnabled: Joi.boolean().optional(),
  voiceAiEnabled: Joi.boolean().optional(),
  calendarProvider: Joi.string()
    .valid("internal", "google", "jobber", "housecall_pro", "servicetitan")
    .optional(),
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

  // Business.phone is provisioned by CallBackIQ and cannot be owner-edited.
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

  forwardingPhone: commonBusinessFields.forwardingPhone.required(),

  timezone: commonBusinessFields.timezone.default("America/New_York"),

  estimatedJobValue: commonBusinessFields.estimatedJobValue.default(null),
}).unknown(false);

const businessUpdateSchema = Joi.object({
  ...commonBusinessFields,
})
  .min(1)
  .unknown(false);

export { businessCreateSchema, businessUpdateSchema };

export default businessCreateSchema;
