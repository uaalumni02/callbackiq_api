import AvailabilityException from "../../models/availabilityException.js";
import AvailabilityRule from "../../models/availabilityRule.js";
import SchedulingPolicy from "../../models/schedulingPolicy.js";
import ServiceArea from "../../models/serviceArea.js";
import ServiceOffering from "../../models/serviceOffering.js";
import { formatDateKey, getUtcDayOfWeekForDateKey } from "./timezone.service.js";

const ZIP_PATTERN = /^\d{5}(?:-\d{4})?$/;

export const getSchedulingPolicy = async (businessId) => {
  const policy = await SchedulingPolicy.findOne({ business: businessId }).lean();

  return {
    minimumNoticeMinutes: 120,
    maximumAdvanceDays: 60,
    slotIntervalMinutes: 30,
    defaultDurationMinutes: 90,
    requireAddressBeforeBooking: true,
    requireServiceBeforeBooking: true,
    allowSameDayBooking: false,
    allowAfterHoursBooking: false,
    customerCancellationAllowed: true,
    cancellationNoticeMinutes: 1440,
    ...(policy || {}),
  };
};

export const getBookableService = async ({ businessId, serviceOfferingId }) => {
  if (!serviceOfferingId) {
    const error = new Error("serviceOfferingId is required.");
    error.statusCode = 400;
    throw error;
  }

  const service = await ServiceOffering.findOne({
    _id: serviceOfferingId,
    business: businessId,
    active: true,
  }).lean();

  if (!service) {
    const error = new Error("The requested service offering was not found.");
    error.statusCode = 404;
    throw error;
  }

  if (!service.aiCanBook && service.aiCanDiscuss === false) {
    const error = new Error("The requested service is not available for booking.");
    error.statusCode = 409;
    error.code = "SERVICE_NOT_BOOKABLE";
    throw error;
  }

  return service;
};

export const validateServiceArea = async ({ businessId, postalCode }) => {
  const normalizedPostalCode = String(postalCode || "").trim();

  if (!normalizedPostalCode) {
    return { supported: true, reason: "not_provided" };
  }

  if (!ZIP_PATTERN.test(normalizedPostalCode)) {
    const error = new Error("postalCode must be a valid US ZIP code.");
    error.statusCode = 400;
    throw error;
  }

  const area = await ServiceArea.findOne({ business: businessId }).lean();

  if (!area || area.type !== "zip_codes" || area.zipCodes.length === 0) {
    return { supported: true, reason: "no_restriction_configured" };
  }

  const fiveDigitZip = normalizedPostalCode.slice(0, 5);
  const supported = area.zipCodes.some((value) => value.slice(0, 5) === fiveDigitZip);

  return {
    supported,
    reason: supported ? "matched" : "outside_configured_service_area",
  };
};

export const validateBookingWindow = ({ startAt, policy, now = new Date() }) => {
  const start = new Date(startAt);

  if (Number.isNaN(start.getTime())) {
    const error = new Error("startAt must be a valid date.");
    error.statusCode = 400;
    throw error;
  }

  const minimumStart = new Date(
    now.getTime() + Number(policy.minimumNoticeMinutes || 0) * 60_000,
  );
  const maximumStart = new Date(
    now.getTime() + Number(policy.maximumAdvanceDays || 60) * 86_400_000,
  );

  if (start < minimumStart) {
    const error = new Error("The selected time does not meet the minimum notice requirement.");
    error.statusCode = 409;
    error.code = "MINIMUM_NOTICE_NOT_MET";
    throw error;
  }

  if (start > maximumStart) {
    const error = new Error("The selected time is beyond the maximum advance-booking period.");
    error.statusCode = 409;
    error.code = "MAXIMUM_ADVANCE_EXCEEDED";
    throw error;
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

