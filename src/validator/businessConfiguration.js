import Joi from "joi";

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const zipPattern = /^\d{5}(?:-\d{4})?$/;

const timeWindowSchema = Joi.object({
  startTime: Joi.string().pattern(timePattern).required(),
  endTime: Joi.string().pattern(timePattern).required(),
});

const serviceFields = {
  name: Joi.string().trim().min(2).max(120),
  category: Joi.string().trim().max(80),
  description: Joi.string().allow("").trim().max(1000),
  active: Joi.boolean(),
  aiCanDiscuss: Joi.boolean(),
  aiCanBook: Joi.boolean(),
  durationMinutes: Joi.number().integer().min(15).max(1440),
  bufferBeforeMinutes: Joi.number().integer().min(0).max(480),
  bufferAfterMinutes: Joi.number().integer().min(0).max(480),
  estimatedValue: Joi.number().min(0).allow(null),
  priceEstimateMin: Joi.number().min(0).allow(null),
  priceEstimateMax: Joi.number().min(0).allow(null),
  disclosePriceEstimate: Joi.boolean(),
  priceEstimateDisclaimer: Joi.string().allow("").trim().max(500),
  diagnosticFee: Joi.number().min(0).allow(null),
  discloseDiagnosticFee: Joi.boolean(),
  emergencyEligible: Joi.boolean(),
  requiresHumanReview: Joi.boolean(),
  keywords: Joi.array().items(Joi.string().trim().max(100)).max(50),
  excludedKeywords: Joi.array().items(Joi.string().trim().max(100)).max(50),
};

export const createServiceOfferingSchema = Joi.object({
  ...serviceFields,
  name: serviceFields.name.required(),
});

export const updateServiceOfferingSchema = Joi.object(serviceFields).min(1);

export const availabilityRulesSchema = Joi.object({
  rules: Joi.array()
    .items(
      Joi.object({
        dayOfWeek: Joi.number().integer().min(0).max(6).required(),
        enabled: Joi.boolean().required(),
        windows: Joi.array().items(timeWindowSchema).max(12).default([]),
        timezone: Joi.string().trim().max(100).default("America/New_York"),
        capacity: Joi.number().integer().min(1).max(100).default(1),
      }),
    )
    .min(1)
    .max(7)
    .required(),
});

export const createAvailabilityExceptionSchema = Joi.object({
  date: Joi.string().pattern(datePattern).required(),
  type: Joi.string()
    .valid(
      "holiday",
      "closure",
      "special_hours",
      "fully_booked",
      "technician_meeting",
      "emergency_only",
    )
    .required(),
  name: Joi.string().allow("").trim().max(120),
  allDay: Joi.boolean().default(true),
  windows: Joi.array().items(timeWindowSchema).max(12).default([]),
  capacity: Joi.number().integer().min(0).max(100).default(0),
  reason: Joi.string().allow("").trim().max(500),
  active: Joi.boolean().default(true),
});

export const updateAvailabilityExceptionSchema =
  createAvailabilityExceptionSchema.fork(
    ["date", "type"],
    (schema) => schema.optional(),
  ).min(1);

export const schedulingPolicySchema = Joi.object({
  minimumNoticeMinutes: Joi.number().integer().min(0).max(43200),
  maximumAdvanceDays: Joi.number().integer().min(1).max(730),
  slotIntervalMinutes: Joi.number().integer().min(5).max(240),
  defaultDurationMinutes: Joi.number().integer().min(15).max(1440),
  requireAddressBeforeBooking: Joi.boolean(),
  requireServiceBeforeBooking: Joi.boolean(),
  allowSameDayBooking: Joi.boolean(),
  allowAfterHoursBooking: Joi.boolean(),
  aiBookingConfirmationMode: Joi.string().valid("auto", "manual"),
  manualApprovalHoldMinutes: Joi.number().integer().min(5).max(1440),
  customerCancellationAllowed: Joi.boolean(),
  cancellationNoticeMinutes: Joi.number().integer().min(0).max(43200),
  confirmationMessageTemplate: Joi.string().allow("").trim().max(1000),
  cancellationMessageTemplate: Joi.string().allow("").trim().max(1000),
  rescheduleMessageTemplate: Joi.string().allow("").trim().max(1000),
}).min(1);

export const serviceAreaSchema = Joi.object({
  type: Joi.string().valid("zip_codes", "radius").required(),
  zipCodes: Joi.array().items(Joi.string().pattern(zipPattern)).max(1000).default([]),
  centerPostalCode: Joi.string().allow("").pattern(zipPattern),
  radiusMiles: Joi.number().min(1).max(500),
});

const handoffContactSchema = Joi.object({
  _id: Joi.any().optional(),
  name: Joi.string().trim().min(1).max(120).required(),
  role: Joi.string().allow("").trim().max(120),
  phone: Joi.string().allow("").trim().max(30),
  email: Joi.string().allow("").trim().email().max(200),
  priority: Joi.number().integer().min(1).max(100),
  active: Joi.boolean(),
  emergencyOnly: Joi.boolean(),
});

export const operationsSettingsSchema = Joi.object({
  humanHandoffContacts: Joi.array().items(handoffContactSchema).max(25),
  emergencyPolicy: Joi.object({
    enabled: Joi.boolean(),
    emergencyContactPhone: Joi.string().allow("").trim().max(30),
    emergencyInstructions: Joi.string().allow("").trim().max(1500),
    customerSafetyMessage: Joi.string().allow("").trim().max(1000),
    afterHoursAction: Joi.string().valid(
      "collect_details",
      "escalate",
      "handoff",
      "emergency_only",
    ),
    pauseAiOnEmergency: Joi.boolean(),
  }),
  aiPermissions: Joi.object({
    canDiscussServices: Joi.boolean(),
    canDiscussDiagnosticFees: Joi.boolean(),
    canCollectAddress: Joi.boolean(),
    canCollectAppointmentPreference: Joi.boolean(),
    canBookEligibleServices: Joi.boolean(),
    canConfirmAvailability: Joi.boolean(),
    requireHumanReviewForUnknownService: Joi.boolean(),
  }),
  followUpSettings: Joi.object({
    enabled: Joi.boolean(),
    maxAttempts: Joi.number().integer().min(0).max(10),
    firstDelayMinutes: Joi.number().integer().min(5).max(10080),
    subsequentDelayMinutes: Joi.number().integer().min(5).max(10080),
    stopOnCustomerReply: Joi.boolean(),
    stopOnHumanTakeover: Joi.boolean(),
  }),
}).min(1);

export const evaluateBookingSchema = Joi.object({
  serviceQuery: Joi.string().allow("").trim().max(300),
  zipCode: Joi.string().allow("").pattern(zipPattern),
  requestedStart: Joi.date().iso().allow(null),
  customerHasAddress: Joi.boolean().default(false),
});
