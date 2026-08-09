import Joi from "joi";

export const demoRequestSchema = Joi.object({
  fullName: Joi.string().trim().min(2).max(100).required(),
  email: Joi.string().trim().email().required(),
  phone: Joi.string().trim().allow("").max(30),
  businessName: Joi.string().trim().min(2).max(120).required(),
  businessType: Joi.string().trim().allow("").max(80),
  monthlyCallVolume: Joi.string()
    .valid("", "under_100", "100_250", "250_500", "500_1000", "1000_plus")
    .default(""),
  website: Joi.string().trim().allow("").max(200),
  preferredTime: Joi.string().trim().allow("").max(120),
  visitorTimezone: Joi.string().trim().allow("").max(100),
  message: Joi.string().trim().allow("").max(1000),
  source: Joi.string().trim().allow("").max(80),
  utmSource: Joi.string().trim().allow("").max(120),
  utmMedium: Joi.string().trim().allow("").max(120),
  utmCampaign: Joi.string().trim().allow("").max(160),
  utmContent: Joi.string().trim().allow("").max(160),
  referrer: Joi.string().trim().allow("").max(500),

  // Honeypot. Legitimate clients leave this empty.
  faxNumber: Joi.string().trim().allow("").max(120),
});

export const publicDemoScheduleSchema = Joi.object({
  token: Joi.string().trim().min(20).max(200).required(),
  scheduledAt: Joi.date().iso().required(),
});

export const publicDemoTokenSchema = Joi.object({
  token: Joi.string().trim().min(20).max(200).required(),
});

export const updateDemoRequestSchema = Joi.object({
  status: Joi.string()
    .valid(
      "new",
      "contacted",
      "scheduled",
      "completed",
      "converted",
      "lost",
      "no_show",
      "cancelled",
      "closed",
      "spam",
    )
    .optional(),

  adminNotes: Joi.string().trim().allow("").max(3000).optional(),
  scheduledAt: Joi.date().iso().allow(null).optional(),
  timezone: Joi.string().trim().allow("").max(100).optional(),
  meetingUrl: Joi.string()
    .trim()
    .uri({ scheme: ["http", "https"] })
    .allow("")
    .max(500)
    .optional(),
  calendarEventId: Joi.string().trim().allow("").max(300).optional(),
  convertedBusiness: Joi.string()
    .trim()
    .pattern(/^[a-f\d]{24}$/i)
    .allow(null, "")
    .optional(),
});
