import AvailabilityException from "../models/availabilityException.js";
import AvailabilityRule from "../models/availabilityRule.js";
import BusinessOperationsSettings from "../models/businessOperationsSettings.js";
import SchedulingPolicy from "../models/schedulingPolicy.js";
import ServiceArea from "../models/serviceArea.js";
import ServiceOffering from "../models/serviceOffering.js";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const defaultRules = (timezone = "America/New_York") =>
  DAY_NAMES.map((_, dayOfWeek) => ({
    dayOfWeek,
    enabled: dayOfWeek >= 1 && dayOfWeek <= 5,
    windows:
      dayOfWeek >= 1 && dayOfWeek <= 5
        ? [{ startTime: "08:00", endTime: "17:00" }]
        : [],
    timezone,
    capacity: 1,
  }));

export const getOrCreateSchedulingPolicy = async (businessId) =>
  SchedulingPolicy.findOneAndUpdate(
    { business: businessId },
    { $setOnInsert: { business: businessId } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );

export const getOrCreateServiceArea = async (businessId) =>
  ServiceArea.findOneAndUpdate(
    { business: businessId },
    { $setOnInsert: { business: businessId, type: "zip_codes" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );

export const getOrCreateOperationsSettings = async (businessId) =>
  BusinessOperationsSettings.findOneAndUpdate(
    { business: businessId },
    { $setOnInsert: { business: businessId } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );

export const ensureAvailabilityRules = async (
  businessId,
  timezone = "America/New_York",
) => {
  const existing = await AvailabilityRule.find({ business: businessId }).sort({
    dayOfWeek: 1,
  });

  if (existing.length === 7) {
    return existing;
  }

  const existingDays = new Set(existing.map((rule) => rule.dayOfWeek));
  const missing = defaultRules(timezone).filter(
    (rule) => !existingDays.has(rule.dayOfWeek),
  );

  if (missing.length) {
    await AvailabilityRule.insertMany(
      missing.map((rule) => ({ ...rule, business: businessId })),
      { ordered: false },
    ).catch((error) => {
      if (error?.code !== 11000) throw error;
    });
  }

  return AvailabilityRule.find({ business: businessId }).sort({ dayOfWeek: 1 });
};

export const getConfigurationReadiness = ({
  services = [],
  rules = [],
  schedulingPolicy,
  serviceArea,
  operationsSettings,
}) => {
  const checks = {
    activeServiceCatalog: services.some((service) => service.active),
    appointmentDurations: services.some(
      (service) => service.active && Number(service.durationMinutes) > 0,
    ),
    operatingHours: rules.some(
      (rule) => rule.enabled && Array.isArray(rule.windows) && rule.windows.length,
    ),
    serviceArea:
      serviceArea?.type === "zip_codes"
        ? Boolean(serviceArea?.zipCodes?.length)
        : Boolean(serviceArea?.centerPostalCode && serviceArea?.radiusMiles),
    schedulingPolicy: Boolean(schedulingPolicy),
    humanHandoff: Boolean(
      operationsSettings?.humanHandoffContacts?.some(
        (contact) => contact.active && (contact.phone || contact.email),
      ),
    ),
    emergencyPolicy: Boolean(operationsSettings?.emergencyPolicy?.enabled),
    aiPermissions: Boolean(operationsSettings?.aiPermissions),
    followUpSettings: Boolean(operationsSettings?.followUpSettings),
  };

  const missing = Object.entries(checks)
    .filter(([, complete]) => !complete)
    .map(([key]) => key);

  return {
    ready: missing.length === 0,
    checks,
    missing,
    completionPercentage: Math.round(
      (Object.values(checks).filter(Boolean).length /
        Object.keys(checks).length) *
        100,
    ),
  };
};

export const getBusinessConfigurationBootstrap = async (business) => {
  const businessId = business._id;

  const [
    services,
    rules,
    exceptions,
    schedulingPolicy,
    serviceArea,
    operationsSettings,
  ] = await Promise.all([
    ServiceOffering.find({ business: businessId }).sort({ active: -1, name: 1 }),
    ensureAvailabilityRules(businessId, business.timezone),
    AvailabilityException.find({ business: businessId, active: true }).sort({
      date: 1,
    }),
    getOrCreateSchedulingPolicy(businessId),
    getOrCreateServiceArea(businessId),
    getOrCreateOperationsSettings(businessId),
  ]);

  const readiness = getConfigurationReadiness({
    services,
    rules,
    schedulingPolicy,
    serviceArea,
    operationsSettings,
  });

  return {
    business: {
      _id: business._id,
      businessName: business.businessName,
      timezone: business.timezone,
      features: business.features || {},
    },
    services,
    availabilityRules: rules,
    availabilityExceptions: exceptions,
    schedulingPolicy,
    serviceArea,
    operationsSettings,
    readiness,
  };
};

export const buildAIConfigurationContext = async (business) => {
  if (!business?._id) {
    return {
      configured: false,
      services: [],
      availabilityRules: [],
      availabilityExceptions: [],
      schedulingPolicy: null,
      serviceArea: null,
      operations: null,
    };
  }

  try {
    const bootstrap = await getBusinessConfigurationBootstrap(business);

    return {
      configured: bootstrap.readiness.ready,
      readiness: bootstrap.readiness,
      services: bootstrap.services
        .filter((service) => service.active && service.aiCanDiscuss)
        .map((service) => ({
          id: service._id,
          name: service.name,
          category: service.category,
          description: service.description,
          aiCanBook: service.aiCanBook,
          durationMinutes: service.durationMinutes,
          bufferBeforeMinutes: service.bufferBeforeMinutes,
          bufferAfterMinutes: service.bufferAfterMinutes,
          estimatedValue: service.estimatedValue,
          diagnosticFee:
            service.discloseDiagnosticFee === true
              ? service.diagnosticFee
              : null,
          emergencyEligible: service.emergencyEligible,
          requiresHumanReview: service.requiresHumanReview,
          keywords: service.keywords,
          excludedKeywords: service.excludedKeywords,
        })),
      availabilityRules: bootstrap.availabilityRules.map((rule) => ({
        dayOfWeek: rule.dayOfWeek,
        dayName: DAY_NAMES[rule.dayOfWeek],
        enabled: rule.enabled,
        windows: rule.windows,
        timezone: rule.timezone,
        capacity: rule.capacity,
      })),
      availabilityExceptions: bootstrap.availabilityExceptions.map(
        (exception) => ({
          date: exception.date,
          type: exception.type,
          name: exception.name,
          allDay: exception.allDay,
          windows: exception.windows,
          capacity: exception.capacity,
        }),
      ),
      schedulingPolicy: bootstrap.schedulingPolicy,
      serviceArea: bootstrap.serviceArea,
      operations: {
        emergencyPolicy: bootstrap.operationsSettings.emergencyPolicy,
        aiPermissions: bootstrap.operationsSettings.aiPermissions,
        followUpSettings: bootstrap.operationsSettings.followUpSettings,
        hasActiveHandoffContact:
          bootstrap.operationsSettings.humanHandoffContacts.some(
            (contact) => contact.active && (contact.phone || contact.email),
          ),
      },
    };
  } catch (error) {
    console.error("Unable to build business configuration context:", {
      businessId: String(business._id),
      message: error.message,
    });

    return {
      configured: false,
      services: [],
      availabilityRules: [],
      availabilityExceptions: [],
      schedulingPolicy: null,
      serviceArea: null,
      operations: null,
      error: "business_configuration_unavailable",
    };
  }
};

export { DAY_NAMES };
