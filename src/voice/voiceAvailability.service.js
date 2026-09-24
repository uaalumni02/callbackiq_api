import { dateWindows, shiftDate } from '../services/scheduling/availabilityWindows.service.js';
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
    const local = getLocalParts(at, resolveBusinessTimeZone(business));
    const [rules, exceptions] = await Promise.all([
      AvailabilityRule.find({ business: business._id }),
      AvailabilityException.find({ business: business._id, active: { $ne: false }, date: { $gte: shiftDate(local.dateKey, -1), $lte: local.dateKey } }),
    ]);
    return dateWindows({ dateKey: local.dateKey, rules, exceptions, scope: 'answering' }).some(([s,e])=>local.minutes >= s && local.minutes < e);
  }

  static async hasPublishedHours(business) {
    if (!business?._id) return false;
    return Boolean(
      await AvailabilityRule.exists({
        business: business._id,
        $or: [
          { separateAnsweringHours: { $ne: true }, enabled: true, "windows.0": { $exists: true } },
          { separateAnsweringHours: true, answeringEnabled: true, "answeringWindows.0": { $exists: true } },
        ],
      }),
    );
  }

  static async describeBusinessHours(business, at = new Date()) {
    if (!business?._id) return 'The team needs to confirm its answering hours.';
    const local = getLocalParts(at, resolveBusinessTimeZone(business));
    const [rules, exceptions] = await Promise.all([
      AvailabilityRule.find({ business: business._id }),
      AvailabilityException.find({ business: business._id, active: { $ne: false }, date: { $gte: shiftDate(local.dateKey, -1), $lte: shiftDate(local.dateKey, 14) } }),
    ]);
    const say = minutes => minutes === 1440 ? 'midnight' : formatClockTimeForSpeech(Math.floor(minutes/60), minutes%60);
    for (let offset=0;offset<=14;offset++) {
      const key=shiftDate(local.dateKey,offset);
      const windows=dateWindows({ dateKey:key, rules, exceptions, scope:'answering' });
      for (const [start,end] of windows) {
        if (!offset && local.minutes >= start && local.minutes < end) return `We’re open now until ${say(end)}.`;
        if (offset || start > local.minutes) {
          const label=offset===0?'today':offset===1?'tomorrow':new Intl.DateTimeFormat('en-US',{weekday:'long',month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(`${key}T12:00:00Z`));
          return `We’re closed right now and reopen ${label} at ${say(start)}.`;
        }
      }
    }
    return 'No answering hours are published for the next two weeks. The team will need to confirm when it reopens.';
  }

}

export default VoiceAvailabilityService;
