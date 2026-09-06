import AvailabilityException from "../../models/availabilityException.js";
import AvailabilityRule from "../../models/availabilityRule.js";
import SchedulingPolicy from "../../models/schedulingPolicy.js";
import ServiceArea from "../../models/serviceArea.js";
import ServiceOffering from "../../models/serviceOffering.js";
import getPostalCodeDistanceMiles from "../location/postalCodeDistance.service.js";
import { formatDateKey, getUtcDayOfWeekForDateKey } from "./timezone.service.js";

const ZIP_PATTERN = /^\d{5}(?:-\d{4})?$/;

const serviceError = (message, statusCode, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

export const getSchedulingPolicy = async (businessId) => {
  const policy = await SchedulingPolicy.findOne({ business: businessId }).lean();

  return {
    minimumNoticeMinutes: 1440,
    maximumAdvanceDays: 60,
    slotIntervalMinutes: 30,
    defaultDurationMinutes: 90,
    requireAddressBeforeBooking: true,
    requireServiceBeforeBooking: true,
    allowSameDayBooking: false,
    allowAfterHoursBooking: false,
    aiBookingConfirmationMode: "manual",
    manualApprovalHoldMinutes: 30,
    customerCancellationAllowed: true,
    cancellationNoticeMinutes: 1440,
    ...(policy || {}),
  };
};

export const getBookableService = async ({ businessId, serviceOfferingId }) => {
  if (!serviceOfferingId) {
    throw serviceError("serviceOfferingId is required.", 400);
  }

  const service = await ServiceOffering.findOne({
    _id: serviceOfferingId,
    business: businessId,
    active: true,
  }).lean();

  if (!service) {
    throw serviceError("The requested service offering was not found.", 404);
  }

  if (
    service.aiCanDiscuss === false &&
    service.aiCanBook !== true
  ) {
    const error = new Error(
      "The requested service is not available for booking.",
    );
    error.statusCode = 409;
    error.code = "SERVICE_NOT_BOOKABLE";
    throw error;
  }

  return service;
};

export const getAiBookableService = async ({
  businessId,
  serviceOfferingId,
}) => {
  let service;
  try {
    service = await getBookableService({
    businessId,
    serviceOfferingId,
  });
  } catch (error) {
    if (error?.code === "SERVICE_NOT_BOOKABLE") {
      const aiError = new Error(
        "The requested service is not available for AI booking.",
      );
      aiError.statusCode = 409;
      aiError.code = "SERVICE_NOT_AI_BOOKABLE";
      throw aiError;
    }
    throw error;
  }

  if (service.aiCanBook !== true) {
    const error = new Error(
      "The requested service is not approved for AI booking.",
    );
    error.statusCode = 409;
    error.code = "SERVICE_NOT_AI_BOOKABLE";
    throw error;
  }

  return service;
};

export const validateServiceArea = async ({
  businessId,
  postalCode,
  distanceResolver = getPostalCodeDistanceMiles,
}) => {
  const normalizedPostalCode = String(postalCode || "").trim();

  if (!normalizedPostalCode) {
    return { supported: true, reason: "not_provided" };
  }

  if (!ZIP_PATTERN.test(normalizedPostalCode)) {
    throw serviceError("postalCode must be a valid US ZIP code.", 400);
  }

  const area = await ServiceArea.findOne({ business: businessId }).lean();

  if (!area) {
    return { supported: true, reason: "no_restriction_configured" };
  }

  const fiveDigitZip = normalizedPostalCode.slice(0, 5);

  if (area.type === "zip_codes") {
    const configuredZipCodes = Array.isArray(area.zipCodes) ? area.zipCodes : [];

    if (configuredZipCodes.length === 0) {
      return { supported: true, reason: "no_restriction_configured" };
    }

    const supported = configuredZipCodes.some(
      (value) => String(value || "").slice(0, 5) === fiveDigitZip,
    );

    return {
      supported,
      reason: supported ? "matched" : "outside_configured_service_area",
      mode: "zip_codes",
    };
  }

  if (area.type === "radius") {
    const centerPostalCode = String(area.centerPostalCode || "").trim().slice(0, 5);
    const radiusMiles = Number(area.radiusMiles);

    if (!ZIP_PATTERN.test(centerPostalCode) || !Number.isFinite(radiusMiles) || radiusMiles <= 0) {
      throw serviceError(
        "The radius service area is missing a valid center ZIP code or radius.",
        409,
        "SERVICE_AREA_CONFIGURATION_INCOMPLETE",
      );
    }

    const distanceMiles = await distanceResolver({
      originPostalCode: centerPostalCode,
      destinationPostalCode: fiveDigitZip,
    });
    const supported = distanceMiles <= radiusMiles;

    return {
      supported,
      reason: supported ? "matched_radius" : "outside_configured_service_area",
      mode: "radius",
      distanceMiles: Number(distanceMiles.toFixed(2)),
      radiusMiles,
      centerPostalCode,
    };
  }

  return { supported: true, reason: "no_restriction_configured" };
};

export const validateBookingWindow = ({
  startAt,
  policy = {},
  now = new Date(),
  timeZone = policy.timezone || policy.timeZone || "America/New_York",
}) => {
  const start = new Date(startAt);

  if (Number.isNaN(start.getTime())) {
    throw serviceError("startAt must be a valid date.", 400);
  }

  if (
    policy.allowSameDayBooking === false &&
    formatDateKey(start, timeZone) === formatDateKey(now, timeZone)
  ) {
    throw serviceError(
      "Same-day booking is disabled for this business.",
      409,
      "SAME_DAY_BOOKING_DISABLED",
    );
  }

  const minimumStart = new Date(
    now.getTime() + Number(policy.minimumNoticeMinutes || 0) * 60_000,
  );
  const maximumStart = new Date(
    now.getTime() + Number(policy.maximumAdvanceDays || 60) * 86_400_000,
  );

  if (start < minimumStart) {
    throw serviceError(
      "The selected time does not meet the minimum notice requirement.",
      409,
      "MINIMUM_NOTICE_NOT_MET",
    );
  }

  if (start > maximumStart) {
    throw serviceError(
      "The selected time is beyond the maximum advance-booking period.",
      409,
      "MAXIMUM_ADVANCE_EXCEEDED",
    );
  }
};

export const getSlotCapacity = async ({ businessId, startAt, timeZone }) => {
  const dateKey = formatDateKey(startAt, timeZone || "America/New_York");
  const dayOfWeek = getUtcDayOfWeekForDateKey(dateKey);
  const [rule, exception] = await Promise.all([
    AvailabilityRule.findOne({ business: businessId, dayOfWeek }).lean(),
    AvailabilityException.findOne({
      business: businessId,
      date: dateKey,
      active: { $ne: false },
    }).lean(),
  ]);

  return Math.max(
    1,
    Math.min(100, Number(exception?.capacity || rule?.capacity || 1)),
  );
};
