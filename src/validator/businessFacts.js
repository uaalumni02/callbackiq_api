import Joi from "joi";

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

const daySchedule = Joi.object({
  closed: Joi.boolean().default(false),
  open: Joi.string().pattern(timePattern).allow("").default(""),
  close: Joi.string().pattern(timePattern).allow("").default(""),
}).custom((value, helpers) => {
  if (!value.closed && (!value.open || !value.close)) {
    return helpers.error("any.custom", {
      message: "Open and close times are required for an open day.",
    });
  }
  return value;
});

const businessHours = Joi.object({
  monday: daySchedule.required(),
  tuesday: daySchedule.required(),
  wednesday: daySchedule.required(),
  thursday: daySchedule.required(),
  friday: daySchedule.required(),
  saturday: daySchedule.required(),
  sunday: daySchedule.required(),
}).unknown(false);

const stringList = Joi.array()
  .items(Joi.string().trim().min(1).max(120))
  .max(100)
  .unique();

const pricing = Joi.object({
  policy: Joi.string()
    .valid("no_quotes", "ranges_only", "configured_prices")
    .required(),
  notes: Joi.string().trim().max(1000).allow("").default(""),
  ranges: Joi.array()
    .items(
      Joi.object({
        service: Joi.string().trim().min(1).max(120).required(),
        minimum: Joi.number().min(0).required(),
        maximum: Joi.number().min(Joi.ref("minimum")).required(),
        disclaimer: Joi.string().trim().max(500).allow("").default(""),
      }),
    )
    .max(50)
    .default([]),
}).unknown(false);

const financing = Joi.object({
  available: Joi.boolean().required(),
  notes: Joi.string().trim().max(1000).allow("").default(""),
}).unknown(false);

const diagnosticFee = Joi.object({
  amount: Joi.number().min(0).required(),
  currency: Joi.string().trim().uppercase().length(3).default("USD"),
  notes: Joi.string().trim().max(500).allow("").default(""),
}).unknown(false);

const factValueSchemas = {
  businessHours,
  approvedServices: stringList,
  serviceAreas: stringList,
  pricing,
  schedulingRules: Joi.string().trim().max(2000),
  availabilityPolicy: Joi.string().trim().max(2000),
  emergencyServiceAvailable: Joi.boolean(),
  financing,
  warrantyPolicy: Joi.string().trim().max(2000),
  cancellationPolicy: Joi.string().trim().max(2000),
  brandsServiced: stringList,
  diagnosticFee,
};

const factEntry = (schema) =>
  Joi.object({
    value: schema.required(),
    verified: Joi.boolean().required(),
  }).unknown(false);

const factsSchema = Joi.object(
  Object.fromEntries(
    Object.entries(factValueSchemas).map(([key, schema]) => [
      key,
      factEntry(schema).optional(),
    ]),
  ),
)
  .min(1)
  .unknown(false);

const capabilitiesSchema = Joi.object({
  canCollectLeadDetails: Joi.boolean(),
  canCollectAddress: Joi.boolean(),
  canCollectAppointmentPreference: Joi.boolean(),

  // These remain false until their separate verified dependencies exist.
  canConfirmAppointment: Joi.valid(false),
  canConfirmAvailability: Joi.valid(false),
  canConfirmDispatch: Joi.valid(false),
  canQuotePrices: Joi.valid(false),
  canConfirmWarranty: Joi.valid(false),
  canConfirmServiceArea: Joi.valid(false),
}).unknown(false);

export const businessFactsUpdateSchema = Joi.object({
  facts: factsSchema.required(),
  capabilities: capabilitiesSchema.optional(),
}).unknown(false);

export { factValueSchemas };
