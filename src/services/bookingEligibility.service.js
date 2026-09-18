import { evaluateServiceAreaPolicy } from "./scheduling/serviceAreaPolicy.service.js";
import { effectiveSchedulingPolicy } from "./scheduling/effectiveSchedulingPolicy.service.js";
import { evaluateServicePolicy } from './serviceEligibility/policy.js';
import AvailabilityException from "../models/availabilityException.js";
import AvailabilityRule from "../models/availabilityRule.js";
import BusinessOperationsSettings from "../models/businessOperationsSettings.js";
import SchedulingPolicy from "../models/schedulingPolicy.js";
import ServiceArea from "../models/serviceArea.js";
import ServiceOffering from "../models/serviceOffering.js";

const normalize = (value) => String(value || "").trim().toLowerCase();


const getZonedParts = (date, timeZone) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dayOfWeek: weekdays[parts.weekday],
    time: `${parts.hour}:${parts.minute}`,
  };
};

const timeFallsInWindows = (time, windows = []) =>
  windows.some((window) => time >= window.startTime && time < window.endTime);

const evaluateAvailability = async ({
  business,
  requestedStart,
  policy,
}) => {
  if (!requestedStart) {
    return {
      available: null,
      reason: "requested_start_required",
      date: null,
      time: null,
    };
  }

  const start = new Date(requestedStart);
  if (Number.isNaN(start.getTime())) {
    return { available: false, reason: "invalid_requested_start" };
  }

  const now = new Date();
  const timeZone = business.timezone || "America/New_York";
  const requested = getZonedParts(start, timeZone);
  const current = getZonedParts(now, timeZone);
  const minutesAhead = (start.getTime() - now.getTime()) / 60000;
  const daysAhead = minutesAhead / 1440;

  if (minutesAhead < Number(policy.minimumNoticeMinutes || 0)) {
    return { available: false, reason: "minimum_notice_not_met", ...requested };
  }

  if (daysAhead > Number(policy.maximumAdvanceDays || 60)) {
    return { available: false, reason: "maximum_advance_exceeded", ...requested };
  }

  if (!policy.allowSameDayBooking && requested.date === current.date) {
    return { available: false, reason: "same_day_booking_disabled", ...requested };
  }

  const exceptions = await AvailabilityException.find({
    business: business._id,
    date: requested.date,
    active: true,
  });

  const fullDayBlock = exceptions.find(
    (exception) =>
      exception.allDay &&
      [
        "holiday",
        "closure",
        "fully_booked",
        "technician_meeting",
        "emergency_only",
      ].includes(exception.type),
  );

  if (fullDayBlock) {
    return {
      available: false,
      reason: `availability_exception:${fullDayBlock.type}`,
      exception: fullDayBlock,
      ...requested,
    };
  }

  const specialHours = exceptions.find(
    (exception) => exception.type === "special_hours",
  );

  const partialBlock = exceptions.find(
    (exception) =>
      !exception.allDay &&
      ["fully_booked", "technician_meeting", "emergency_only"].includes(
        exception.type,
      ) &&
      timeFallsInWindows(requested.time, exception.windows),
  );

  if (partialBlock) {
    return {
      available: false,
      reason: `availability_exception:${partialBlock.type}`,
      exception: partialBlock,
      ...requested,
    };
  }

  const rule = await AvailabilityRule.findOne({
    business: business._id,
    dayOfWeek: requested.dayOfWeek,
  });

  const windows = specialHours?.windows?.length
    ? specialHours.windows
    : rule?.windows || [];
  const enabled = specialHours ? true : Boolean(rule?.enabled);

  if (!enabled || !windows.length) {
    if (policy.allowAfterHoursBooking) {
      return { available: true, reason: "after_hours_booking_allowed", ...requested };
    }

    return { available: false, reason: "business_closed", ...requested };
  }

  if (!timeFallsInWindows(requested.time, windows)) {
    if (policy.allowAfterHoursBooking) {
      return { available: true, reason: "after_hours_booking_allowed", ...requested };
    }

    return { available: false, reason: "outside_operating_window", ...requested };
  }

  return {
    available: true,
    reason: "operating_window_available",
    capacity: specialHours?.capacity || rule?.capacity || 1,
    ...requested,
  };
};

export const evaluateBookingEligibility = async ({
  business,
  serviceQuery,
  zipCode,
  requestedStart,
  customerHasAddress = false,
}) => {
  const [services, policy, serviceArea, operations] = await Promise.all([
    ServiceOffering.find({ business: business._id, active: true }).sort({ name: 1 }),
    SchedulingPolicy.findOne({ business: business._id }),
    ServiceArea.findOne({ business: business._id }),
    BusinessOperationsSettings.findOne({ business: business._id }),
  ]);

  const serviceEligibility = evaluateServicePolicy({ request: serviceQuery, services, policy: operations?.serviceEligibilityPolicy || {} });
  const service = ['supported', 'needs_staff_review'].includes(serviceEligibility.decision) ? services.find(item => String(item._id) === serviceEligibility.serviceId) || null : null;
  const resolvedPolicy = effectiveSchedulingPolicy(policy?.toObject?.() || policy || {
    minimumNoticeMinutes: 1440,
    maximumAdvanceDays: 60,
    requireAddressBeforeBooking: true,
    requireServiceBeforeBooking: true,
    allowSameDayBooking: false,
    allowAfterHoursBooking: false,
    defaultDurationMinutes: 90,
  }, service || {});

  const serviceAreaResult = await evaluateServiceAreaPolicy({ area: serviceArea, postalCode: zipCode });
  const availability = await evaluateAvailability({
    business,
    requestedStart,
    policy: resolvedPolicy,
  });

  const emergencyEscalation = Boolean(service?.emergencyEligible);
  const requiresHumanReview = Boolean(
    serviceEligibility.decision === 'needs_staff_review' || service?.requiresHumanReview ||
      emergencyEscalation ||
      (!service && operations?.aiPermissions?.requireHumanReviewForUnknownService),
  );

  const reasons = [];
  if (!service) reasons.push("service_not_matched");
  if (service && !service.aiCanBook) reasons.push("service_ai_booking_disabled");
  if (requiresHumanReview) reasons.push("human_review_required");
  if (serviceAreaResult.supported !== true) reasons.push(serviceAreaResult.reason);
  if (availability.available !== true) reasons.push(availability.reason);
  if (
    resolvedPolicy.requireAddressBeforeBooking &&
    !customerHasAddress
  ) {
    reasons.push("address_required");
  }
  if (resolvedPolicy.requireServiceBeforeBooking && !service) {
    reasons.push("service_required");
  }
  if (business.features?.aiBookingEnabled !== true) {
    reasons.push("business_ai_booking_feature_disabled");
  }
  if (operations?.aiPermissions?.canBookEligibleServices !== true) {
    reasons.push("operations_ai_booking_permission_disabled");
  }

  const mayAiBook =
    serviceEligibility.decision === 'supported' && Boolean(service) &&
    service.aiCanBook === true &&
    !requiresHumanReview &&
    serviceAreaResult.supported === true &&
    availability.available === true &&
    (!resolvedPolicy.requireAddressBeforeBooking || customerHasAddress) &&
    business.features?.aiBookingEnabled === true &&
    operations?.aiPermissions?.canBookEligibleServices === true;

  return {
    serviceEligibility,
    servicePerformed: Boolean(service),
    matchedService: service,
    locationSupported: serviceAreaResult.supported,
    serviceAreaReason: serviceAreaResult.reason,
    durationMinutes:
      service?.durationMinutes || resolvedPolicy.defaultDurationMinutes,
    totalBlockMinutes:
      (service?.bufferBeforeMinutes || 0) +
      (service?.durationMinutes || resolvedPolicy.defaultDurationMinutes) +
      (service?.bufferAfterMinutes || 0),
    availability,
    serviceAiCanBook: Boolean(service?.aiCanBook),
    businessAiBookingEnabled: business.features?.aiBookingEnabled === true,
    operationsAiBookingAllowed:
      operations?.aiPermissions?.canBookEligibleServices === true,
    mayAiBook,
    requiresHumanReview,
    emergencyEscalation,
    handoffAvailable: Boolean(
      operations?.humanHandoffContacts?.some(
        (contact) => contact.active && (contact.phone || contact.email),
      ),
    ),
    reasons: [...new Set(reasons.filter(Boolean))],
  };
};
