import AvailabilityException from "../models/availabilityException.js";
import AvailabilityRule from "../models/availabilityRule.js";
import { logOperationalWarning } from "../helpers/logging/safeLogger.js";
import { formatClockTimeForSpeech } from "./voiceInput.service.js";
import {
  timeToMinutes,
  windowKind,
  withinTimeWindow,
} from "./voiceTimeWindow.service.js";

export { timeToMinutes, windowKind, withinTimeWindow };

const DEFAULT_TIMEZONE = "America/New_York";
const CLOSED_EXCEPTION_TYPES = new Set([
  "holiday",
  "closure",
  "fully_booked",
  "technician_meeting",
  "emergency_only",
]);
const DAY_NAMES = Object.freeze([
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]);

export const isValidTimeZone = (value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

export const resolveBusinessTimeZone = (business) => {
  const configured = String(business?.timezone || "").trim();
  if (configured && isValidTimeZone(configured)) return configured;

  if (configured) {
    logOperationalWarning("voice.invalid_business_timezone", {
      businessId: business?._id,
      configuredTimezone: configured.slice(0, 100),
      fallbackTimezone: DEFAULT_TIMEZONE,
    });
  }
  return DEFAULT_TIMEZONE;
};

const getLocalParts = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dayOfWeek = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }[values.weekday];
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    dayOfWeek,
    time: `${values.hour}:${values.minute}`,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
};

const previousDateKey = (dateKey) => {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

const exceptionClosesDate = (exception) =>
  Boolean(exception) &&
  (CLOSED_EXCEPTION_TYPES.has(exception.type) ||
    (exception.allDay && exception.type !== "special_hours"));

const anyCurrentWindowOpen = (windows, minutes) =>
  (windows || []).some((window) => withinTimeWindow(minutes, window));
const anySpilloverWindowOpen = (windows, minutes) =>
  (windows || []).some((window) =>
    withinTimeWindow(minutes, window, { previousDaySpillover: true }),
  );

const describeWindow = (window) => {
  const kind = windowKind(window);
  if (kind === "all_day") return "all day";
  if (kind === "invalid") return "an invalid time window";

  const [startHour, startMinute] = String(window.startTime).split(":");
  const [endHour, endMinute] = String(window.endTime).split(":");
  const start = formatClockTimeForSpeech(startHour, startMinute);
  const end = formatClockTimeForSpeech(endHour, endMinute);
  return kind === "overnight"
    ? `${start} to ${end} the next day`
    : `${start} to ${end}`;
};

class VoiceAvailabilityService {
  static async isBusinessOpen(business, at = new Date()) {
    if (!business?._id) return false;
    const timeZone = resolveBusinessTimeZone(business);
    const local = getLocalParts(at, timeZone);
    const priorDate = previousDateKey(local.dateKey);
    const priorDay = (local.dayOfWeek + 6) % 7;

    const [currentException, priorException] = await Promise.all([
      AvailabilityException.findOne({
        business: business._id,
        date: local.dateKey,
        active: true,
      }).sort({ createdAt: -1 }),
      AvailabilityException.findOne({
        business: business._id,
        date: priorDate,
        active: true,
        type: "special_hours",
      }).sort({ createdAt: -1 }),
    ]);

    if (exceptionClosesDate(currentException)) return false;

    if (
      priorException?.type === "special_hours" &&
      anySpilloverWindowOpen(priorException.windows, local.minutes)
    ) {
      return true;
    }

    if (currentException?.type === "special_hours") {
      return anyCurrentWindowOpen(currentException.windows, local.minutes);
    }

    const [currentRule, priorRule] = await Promise.all([
      AvailabilityRule.findOne({
        business: business._id,
        dayOfWeek: local.dayOfWeek,
      }),
      AvailabilityRule.findOne({
        business: business._id,
        dayOfWeek: priorDay,
      }),
    ]);

    if (
      priorRule?.enabled &&
      anySpilloverWindowOpen(priorRule.windows, local.minutes)
    ) {
      return true;
    }
    if (!currentRule?.enabled) return false;
    return anyCurrentWindowOpen(currentRule.windows, local.minutes);
  }

  static async hasPublishedHours(business) {
    if (!business?._id) return false;
    return Boolean(
      await AvailabilityRule.exists({
        business: business._id,
        enabled: true,
        "windows.0": { $exists: true },
      }),
    );
  }

  static async describeBusinessHours(business, at = new Date()) {
    if (!business?._id) {
      return "The business has not published verified operating hours yet, so I’ll have the team confirm them directly.";
    }
    const timeZone = resolveBusinessTimeZone(business);
    const local = getLocalParts(at, timeZone);
    const [rules, currentException] = await Promise.all([
      AvailabilityRule.find({ business: business._id }).sort({ dayOfWeek: 1 }),
      AvailabilityException.findOne({ business: business._id, date: local.dateKey, active: true }).sort({ createdAt: -1 }),
    ]);
    const todayRule = rules.find((rule) => rule.dayOfWeek === local.dayOfWeek);
    const active = exceptionClosesDate(currentException)
      ? []
      : currentException?.type === "special_hours"
        ? currentException.windows || []
        : todayRule?.enabled && Array.isArray(todayRule.windows)
          ? todayRule.windows
          : [];
    const current = active.find((window) => withinTimeWindow(local.minutes, window));
    if (current) {
      return `We’re open now until ${formatClockTimeForSpeech(...String(current.endTime).split(":"))}.`;
    }
    const later = active.find((window) => timeToMinutes(window.startTime) > local.minutes);
    if (later) {
      return `We’re closed right now and reopen today at ${formatClockTimeForSpeech(...String(later.startTime).split(":"))}.`;
    }
    for (let offset = 1; offset <= 7; offset += 1) {
      const day = (local.dayOfWeek + offset) % 7;
      const rule = rules.find((item) => item.dayOfWeek === day && item.enabled && item.windows?.length);
      if (rule) {
        const first = rule.windows[0];
        const label = offset === 1 ? "tomorrow" : DAY_NAMES[day];
        return `Published hours show the business reopening ${label} at ${formatClockTimeForSpeech(...String(first.startTime).split(":"))}.`;
      }
    }
    return "The business has not published verified operating hours yet, so I’ll have the team confirm them directly.";
  }
}

export default VoiceAvailabilityService;
