import AvailabilityException from "../models/availabilityException.js";
import AvailabilityRule from "../models/availabilityRule.js";

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
  };
};

const withinWindow = (time, window) =>
  Boolean(window?.startTime && window?.endTime) &&
  time >= window.startTime &&
  time < window.endTime;

class VoiceAvailabilityService {
  static async isBusinessOpen(business, at = new Date()) {
    const timeZone = business?.timezone || "America/New_York";
    const local = getLocalParts(at, timeZone);
    const exception = await AvailabilityException.findOne({
      business: business._id,
      date: local.dateKey,
      active: true,
    }).sort({ createdAt: -1 });

    if (exception) {
      if (
        exception.allDay &&
        ["holiday", "closure", "fully_booked", "technician_meeting"].includes(
          exception.type,
        )
      ) {
        return false;
      }
      if (exception.type === "emergency_only") return false;
      if (exception.type === "special_hours") {
        return (exception.windows || []).some((window) =>
          withinWindow(local.time, window),
        );
      }
    }

    const rule = await AvailabilityRule.findOne({
      business: business._id,
      dayOfWeek: local.dayOfWeek,
    });
    if (!rule?.enabled) return false;

    return (rule.windows || []).some((window) =>
      withinWindow(local.time, window),
    );
  }

  static async describeBusinessHours(business) {
    const rules = await AvailabilityRule.find({ business: business._id }).sort({
      dayOfWeek: 1,
    });
    const dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const enabled = rules.filter((rule) => rule.enabled && rule.windows?.length);

    if (!enabled.length) {
      return "The business has not published verified operating hours yet, so I’ll have the team confirm them directly.";
    }

    const text = enabled
      .map(
        (rule) =>
          `${dayNames[rule.dayOfWeek]} ${rule.windows
            .map((window) => `${window.startTime} to ${window.endTime}`)
            .join(" and ")}`,
      )
      .join("; ");

    return `The published business hours are ${text}, in ${
      business.timezone || "the business timezone"
    }.`;
  }
}

export default VoiceAvailabilityService;
