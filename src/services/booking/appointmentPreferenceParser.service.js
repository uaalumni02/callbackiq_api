import { schedulingEvidence } from './schedulingEvidence.service.js';
const DAY_MS = 86_400_000;

const MONTHS = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
};

const WEEKDAYS = [
  { index: 0, pattern: /\b(?:sun|sunday)\b/i },
  { index: 1, pattern: /\b(?:mon|monday)\b/i },
  { index: 2, pattern: /\b(?:tue|tues|tuesday)\b/i },
  { index: 3, pattern: /\b(?:wed|weds|wednesday)\b/i },
  { index: 4, pattern: /\b(?:thu|thur|thurs|thursday)\b/i },
  { index: 5, pattern: /\b(?:fri|friday)\b/i },
  { index: 6, pattern: /\b(?:sat|saturday)\b/i },
];

const TODAY_PATTERN = /\b(?:today|2day|later today|sometime today|this morning|this afternoon|this evening|tonight|this eve(?:ning)?)\b/i;
const TOMORROW_PATTERN = /\b(?:tomorrow|tmrw|tmr|tmw|2moro|2morrow|tomo|tomm?orrow)\b/i;
const DAY_AFTER_TOMORROW_PATTERN = /\b(?:day after tomorrow|day after tmrw|day after tmr|day after next|overmorrow|two days from now|2 days from now|in two days|in 2 days)\b/i;
const ASAP_PATTERN = /\b(?:asap|a\.?s\.?a\.?p\.?|as soon as possible|soonest|earliest(?: available)?|first available|next available|whenever you can|whenever(?: is)? possible)\b/i;
// Bare timing answers only: "not now" or "it leaks now" are not scheduling consent.
export const isImmediatePreference = value => /^(?:(?:right\s+)?now|immediately|asap|as soon as possible|(?:the\s+)?(?:earliest|soonest|first|next)\s+available)(?:\s+please)?[.! ]*$/i.test(normalizeText(value));

const normalizeText = (value) =>
  String(value || "")
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

const TIME_NUMBER_WORDS = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
};

const normalizeTimeWords = (value) =>
  normalizeText(value)
    .replace(/\b(\d{1,2})(:[0-5]\d)?\s*([ap])\b/gi, (_, hour, minutes, meridiem) => `${hour}${minutes || ''}${meridiem}m`)
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi,
      (word) => TIME_NUMBER_WORDS[word.toLowerCase()] || word)
    .replace(/\b(\d{1,2})\s+thirty\b/gi, "$1:30")
    .replace(/\b(\d{1,2})\s+fifteen\b/gi, "$1:15")
    .replace(/\b(\d{1,2})\s+(?:forty[- ]?five)\b/gi, "$1:45");

const localDateKey = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(date));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
};

const parseDateKey = (dateKey) => {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  return { year, month, day };
};

const validDateParts = (year, month, day) => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 2000 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const check = new Date(Date.UTC(year, month - 1, day, 12));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
};

const dateKey = (year, month, day) =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const shiftDateKey = (value, days) => {
  const { year, month, day } = parseDateKey(value);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12));
  return dateKey(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
};

const compareDateKeys = (a, b) => String(a).localeCompare(String(b));

const weekdayIndexForDateKey = (value) => {
  const { year, month, day } = parseDateKey(value);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
};

const startOfNextWeek = (todayKey) => {
  const weekday = weekdayIndexForDateKey(todayKey);
  const daysUntilMonday = ((8 - weekday) % 7) || 7;
  return shiftDateKey(todayKey, daysUntilMonday);
};

const upcomingSaturday = (todayKey, includeToday = true) => {
  const weekday = weekdayIndexForDateKey(todayKey);
  let daysAhead = (6 - weekday + 7) % 7;
  if (!includeToday && daysAhead === 0) daysAhead = 7;
  return shiftDateKey(todayKey, daysAhead);
};

const resolveYearlessDate = ({ month, day, todayKey }) => {
  const { year: currentYear } = parseDateKey(todayKey);
  if (!validDateParts(currentYear, month, day)) return null;
  let candidate = dateKey(currentYear, month, day);
  if (compareDateKeys(candidate, todayKey) < 0) {
    if (!validDateParts(currentYear + 1, month, day)) return null;
    candidate = dateKey(currentYear + 1, month, day);
  }
  return candidate;
};

const resolveOrdinalDay = ({ day, todayKey }) => {
  const { year, month } = parseDateKey(todayKey);
  if (validDateParts(year, month, day)) {
    const thisMonth = dateKey(year, month, day);
    if (compareDateKeys(thisMonth, todayKey) >= 0) return thisMonth;
  }
  const nextMonthDate = new Date(Date.UTC(year, month, 1, 12));
  const nextYear = nextMonthDate.getUTCFullYear();
  const nextMonth = nextMonthDate.getUTCMonth() + 1;
  return validDateParts(nextYear, nextMonth, day)
    ? dateKey(nextYear, nextMonth, day)
    : null;
};

const parseRelativeDayCount = (text) => {
  const match = text.match(
    /\b(?:in\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen)\s+days?(?:\s+from\s+(?:now|today))?\b/i,
  );
  if (!match) return null;
  const raw = match[1].toLowerCase();
  const days = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
  return Number.isInteger(days) && days >= 0 && days <= 60 ? days : null;
};

const parseExplicitCalendarDate = (text, todayKey) => {
  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    return validDateParts(year, month, day) ? dateKey(year, month, day) : null;
  }

  const numeric = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2}|\d{4}))?\b/);
  if (numeric) {
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    if (numeric[3]) {
      let year = Number(numeric[3]);
      if (year < 100) year += year >= 70 ? 1900 : 2000;
      return validDateParts(year, month, day) ? dateKey(year, month, day) : null;
    }
    return resolveYearlessDate({ month, day, todayKey });
  }

  const monthNames = Object.keys(MONTHS).join("|");
  const monthFirst = text.match(
    new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "i"),
  );
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    const day = Number(monthFirst[2]);
    const year = monthFirst[3] ? Number(monthFirst[3]) : null;
    if (year) return validDateParts(year, month, day) ? dateKey(year, month, day) : null;
    return resolveYearlessDate({ month, day, todayKey });
  }

  const dayFirst = text.match(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthNames})(?:\\.?[,]?\\s+(20\\d{2}))?\\b`, "i"),
  );
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = MONTHS[dayFirst[2].toLowerCase()];
    const year = dayFirst[3] ? Number(dayFirst[3]) : null;
    if (year) return validDateParts(year, month, day) ? dateKey(year, month, day) : null;
    return resolveYearlessDate({ month, day, todayKey });
  }

  const ordinalOnly = text.match(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i);
  if (ordinalOnly) {
    return resolveOrdinalDay({ day: Number(ordinalOnly[1]), todayKey });
  }

  return null;
};

export const findDateRange = (message, timeZone = "America/New_York", now = new Date()) => {
  message = schedulingEvidence(message).text;
  // FIX: explicit ISO booking date ranges
  const explicitIsoRangeForBookingWindow = String(message || "")
    .trim()
    .match(
      /\b(20\d{2}-\d{2}-\d{2})\s+(?:through|thru|to|until)\s+(20\d{2}-\d{2}-\d{2})\b/i,
    );

  if (explicitIsoRangeForBookingWindow) {
    const [, firstDate, secondDate] = explicitIsoRangeForBookingWindow;
    const first = parseDateKey(firstDate), second = parseDateKey(secondDate);
    if (!validDateParts(first.year, first.month, first.day) || !validDateParts(second.year, second.month, second.day) ||
        firstDate > secondDate || new Date(secondDate) - new Date(firstDate) > 366 * DAY_MS) return null;

    return {
      startDate: firstDate,
      endDate: secondDate,
    };
  }

  const text = normalizeText(message);
  if (!text) return null;

  const todayKey = localDateKey(now, timeZone);

  if (/^(?:right now|now|immediately)(?: please)?[.! ]*$/i.test(text)) {
    return { startDate: todayKey, endDate: todayKey };
  }

  // Check two-day phrases before "tomorrow" because they contain that word.
  if (DAY_AFTER_TOMORROW_PATTERN.test(text)) {
    const key = shiftDateKey(todayKey, 2);
    return { startDate: key, endDate: key };
  }

  const explicitDate = parseExplicitCalendarDate(text, todayKey);
  if (explicitDate) return { startDate: explicitDate, endDate: explicitDate };

  if (TODAY_PATTERN.test(text)) {
    return { startDate: todayKey, endDate: todayKey };
  }

  if (TOMORROW_PATTERN.test(text)) {
    const key = shiftDateKey(todayKey, 1);
    return { startDate: key, endDate: key };
  }

  if (/\b(?:next few days|next couple(?: of)? days|over the next few days)\b/i.test(text)) {
    return { startDate: todayKey, endDate: shiftDateKey(todayKey, 3) };
  }

  if (/\b(?:within|sometime in)\s+(?:a\s+)?(?:couple|two)\s+days\b/i.test(text)) {
    return { startDate: todayKey, endDate: shiftDateKey(todayKey, 2) };
  }

  const relativeDays = parseRelativeDayCount(text);
  if (relativeDays !== null) {
    const key = shiftDateKey(todayKey, relativeDays);
    return { startDate: key, endDate: key };
  }

  if (ASAP_PATTERN.test(text)) {
    return { startDate: todayKey, endDate: shiftDateKey(todayKey, 14) };
  }

  if (/\bnext\s+weekend\b/i.test(text)) {
    const saturday = shiftDateKey(upcomingSaturday(todayKey, true), 7);
    return { startDate: saturday, endDate: shiftDateKey(saturday, 1) };
  }

  if (/\b(?:this|coming)\s+weekend\b|\bweekend\b/i.test(text)) {
    const saturday = upcomingSaturday(todayKey, true);
    return { startDate: saturday, endDate: shiftDateKey(saturday, 1) };
  }

  const nextWeekStart = startOfNextWeek(todayKey);
  if (/\b(?:early\s+next\s+week|beginning\s+of\s+next\s+week)\b/i.test(text)) {
    return { startDate: nextWeekStart, endDate: shiftDateKey(nextWeekStart, 2) };
  }
  if (/\b(?:mid\s*next\s+week|middle\s+of\s+next\s+week)\b/i.test(text)) {
    return { startDate: shiftDateKey(nextWeekStart, 1), endDate: shiftDateKey(nextWeekStart, 3) };
  }
  if (/\b(?:late\s+next\s+week|end\s+of\s+next\s+week)\b/i.test(text)) {
    return { startDate: shiftDateKey(nextWeekStart, 3), endDate: shiftDateKey(nextWeekStart, 6) };
  }
  const weekdayNamedForRelativeWeek = WEEKDAYS.find(({ pattern }) => pattern.test(text));
  if (weekdayNamedForRelativeWeek && /\b(?:sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\s+(?:of\s+)?next\s+(?:wk|week)\b/i.test(text)) {
    const mondayIndexed = (weekdayNamedForRelativeWeek.index + 6) % 7;
    const resolved = shiftDateKey(nextWeekStart, mondayIndexed);
    return { startDate: resolved, endDate: resolved };
  }
  if (weekdayNamedForRelativeWeek && /\b(?:the\s+)?(?:sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\s+after\s+next\b/i.test(text)) {
    const mondayIndexed = (weekdayNamedForRelativeWeek.index + 6) % 7;
    const resolved = shiftDateKey(nextWeekStart, 7 + mondayIndexed);
    return { startDate: resolved, endDate: resolved };
  }
  if (/\bnext\s+(?:wk|week)\b/i.test(text)) {
    return { startDate: nextWeekStart, endDate: shiftDateKey(nextWeekStart, 6) };
  }

  const currentWeekday = weekdayIndexForDateKey(todayKey);
  if (/\b(?:later\s+this\s+week|rest\s+of\s+(?:the\s+)?week)\b/i.test(text)) {
    const endOfWeek = shiftDateKey(todayKey, 7 - currentWeekday);
    return { startDate: shiftDateKey(todayKey, 1), endDate: endOfWeek };
  }
  if (/\b(?:end\s+of\s+(?:the\s+)?week|late\s+this\s+week)\b/i.test(text)) {
    const thursdayOffset = (4 - currentWeekday + 7) % 7;
    const startDate = shiftDateKey(todayKey, thursdayOffset);
    const endDate = shiftDateKey(todayKey, 7 - currentWeekday);
    return { startDate, endDate };
  }
  if (/\bthis\s+(?:wk|week)\b/i.test(text)) {
    return { startDate: todayKey, endDate: shiftDateKey(todayKey, 7 - currentWeekday) };
  }

  const matchedWeekday = WEEKDAYS.find(({ pattern }) => pattern.test(text));
  if (matchedWeekday) {
    const explicitlyNext = /\bnext\s+(?:sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\b/i.test(text);
    const explicitlyThis = /\b(?:this|coming)\s+(?:sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\b/i.test(text);
    let daysAhead = (matchedWeekday.index - currentWeekday + 7) % 7;
    if (explicitlyNext) {
      // "Next Tuesday" said on a Thursday means the Tuesday of next calendar
      // week (5 days away), not the one after it. Resolve to the named weekday
      // inside the week that starts next Monday.
      const mondayIndexed = (matchedWeekday.index + 6) % 7;
      const resolved = shiftDateKey(nextWeekStart, mondayIndexed);
      return { startDate: resolved, endDate: resolved };
    }
    else if (daysAhead === 0 && !explicitlyThis) daysAhead = 7;
    const key = shiftDateKey(todayKey, daysAhead);
    return { startDate: key, endDate: key };
  }

  if (/\bnext\s+month\b/i.test(text)) {
    const { year, month } = parseDateKey(todayKey);
    const first = new Date(Date.UTC(year, month, 1, 12));
    const firstKey = dateKey(first.getUTCFullYear(), first.getUTCMonth() + 1, 1);
    const afterNext = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1, 12));
    const last = new Date(afterNext.getTime() - DAY_MS);
    return {
      startDate: firstKey,
      endDate: dateKey(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate()),
    };
  }

  // Relative-hour language implies today unless the calculated instant crosses
  // into the next local date.
  const relativeHours = text.match(/\b(?:in\s+)?(an?|one|two|three|four|five|six|\d{1,2}|couple(?: of)?|few)\s+hours?(?:\s+from\s+now)?\b/i);
  if (relativeHours) {
    const raw = relativeHours[1].toLowerCase();
    const hours = raw === "a" || raw === "an" || raw === "one" ? 1
      : raw.startsWith("couple") ? 2
        : raw === "few" ? 3
          : NUMBER_WORDS[raw] || Number(raw);
    if (Number.isFinite(hours)) {
      const targetKey = localDateKey(new Date(new Date(now).getTime() + hours * 3_600_000), timeZone);
      return { startDate: targetKey, endDate: targetKey };
    }
  }

  return null;
};

const inferBareHour = (hour, contextText = "") => {
  const normalized = normalizeText(contextText).toLowerCase();
  if (/\b(?:morning|am|before lunch|breakfast|bright and early|first thing)\b/.test(normalized)) {
    return hour % 12;
  }
  if (/\b(?:afternoon|evening|tonight|pm|after lunch|after work|later in the day|eod|end of day)\b/.test(normalized)) {
    return (hour % 12) + 12;
  }
  if (hour === 12) return 12;
  // Home-service scheduling heuristic: 1-6 is normally afternoon; 7-11 is
  // normally morning. Explicit AM/PM language always overrides this.
  if (hour >= 1 && hour <= 6) return hour + 12;
  return hour;
};

const parseHourMinute = (rawHour, rawMinute, meridiem, contextText = "") => {
  let hour = Number(rawHour);
  const minute = Number(rawMinute || 0);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  if (meridiem) {
    const normalized = meridiem.toLowerCase().replace(/[^apm]/g, "");
    if (hour < 1 || hour > 12) return null;
    hour %= 12;
    if (normalized.startsWith("p")) hour += 12;
  } else if (hour >= 0 && hour <= 23) {
    if (hour <= 12) hour = inferBareHour(hour, contextText);
  } else {
    return null;
  }

  return hour * 60 + minute;
};

const clockPhraseMinutes = (text) => {
  text = normalizeTimeWords(text);
  if (/\b(?:noon|12\s*noon|midday|high noon)\b/i.test(text)) return { minutes: 12 * 60, toleranceMinutes: 0 };
  if (/\b(?:midnight|12\s*midnight)\b/i.test(text)) return { minutes: 0, toleranceMinutes: 0 };

  let match = text.match(/\bhalf\s+past\s+(\d{1,2})\b/i);
  if (match) return { minutes: parseHourMinute(match[1], 30, null, text), toleranceMinutes: 0 };

  match = text.match(/\bquarter\s+past\s+(\d{1,2})\b/i);
  if (match) return { minutes: parseHourMinute(match[1], 15, null, text), toleranceMinutes: 0 };

  match = text.match(/\bquarter\s+(?:to|til|till|before)\s+(\d{1,2})\b/i);
  if (match) {
    const nextHour = parseHourMinute(match[1], 0, null, text);
    return { minutes: nextHour === null ? null : (nextHour + 24 * 60 - 15) % (24 * 60), toleranceMinutes: 0 };
  }

  match = text.match(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?|a|p)\b/i);
  if (match) return { minutes: parseHourMinute(match[1], match[2], match[3], text), toleranceMinutes: 0 };

  match = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (match) return { minutes: /^0\d$/.test(match[1]) || Number(match[1]) > 12
    ? Number(match[1]) * 60 + Number(match[2])
    : parseHourMinute(match[1], match[2], null, text), toleranceMinutes: 0 };

  match = text.match(/\b(?:around|right around|about|roughly|approximately|approx\.?|close to|near|like|give or take)\s+(\d{1,2})(?::([0-5]\d))?\s*(?:ish)?\b/i);
  if (match) return { minutes: parseHourMinute(match[1], match[2], null, text), toleranceMinutes: 60 };

  match = text.match(/\b(\d{1,2})(?::([0-5]\d))?\s*[- ]?ish\b/i);
  if (match) return { minutes: parseHourMinute(match[1], match[2], null, text), toleranceMinutes: 60 };

  match = text.match(/\b(?:at|around|about)\s+(\d{1,2})(?::([0-5]\d))?\s*(?:o'?clock)?\b/i);
  if (match) return { minutes: parseHourMinute(match[1], match[2], null, text), toleranceMinutes: /\b(?:around|about)\b/i.test(match[0]) ? 60 : 0 };

  match = text.match(/\b(\d{1,2})\s*o'?clock\b/i);
  if (match) return { minutes: parseHourMinute(match[1], 0, null, text), toleranceMinutes: 0 };

  return { minutes: null, toleranceMinutes: 0 };
};

const relativeHourPreference = (text, timeZone, now) => {
  const match = text.match(/\b(?:in\s+)?(an?|one|two|three|four|five|six|\d{1,2}|couple(?: of)?|few)\s+hours?(?:\s+from\s+now)?\b/i);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  const hours = raw === "a" || raw === "an" || raw === "one" ? 1
    : raw.startsWith("couple") ? 2
      : raw === "few" ? 3
        : NUMBER_WORDS[raw] || Number(raw);
  if (!Number.isFinite(hours)) return null;
  const target = new Date(new Date(now).getTime() + hours * 3_600_000);
  return {
    targetMinutes: localClockMinutes(target, timeZone),
    exactMinutes: null,
    toleranceMinutes: 60,
  };
};

export const parseTimePreference = (
  message,
  timeZone = "America/New_York",
  now = new Date(),
) => {
  const text = normalizeText(schedulingEvidence(message).text);
  // Dates must not accidentally become clock ranges (2026-09-09 -> 09-09).
  const timeText = normalizeTimeWords(text.replace(/\b20\d{2}-\d{1,2}-\d{1,2}\b/g, '').replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ''));
  const lower = text.toLowerCase();

  let timeOfDay = "";
  let windowStartMinutes = null;
  let windowEndMinutes = null;
  let targetMinutes = null;
  let exactMinutes = null;
  let toleranceMinutes = 0;

  if (isImmediatePreference(text)) {
    return { timeOfDay: '', exactMinutes: null, targetMinutes: 0,
      toleranceMinutes: 0, windowStartMinutes: null, windowEndMinutes: null, raw: lower };
  }

  const setWindow = (start, end, dayPart = "") => {
    windowStartMinutes = start;
    windowEndMinutes = end;
    if (dayPart) timeOfDay = dayPart;
  };

  if (/\b(?:first thing|first thing in the morning|bright and early|crack of dawn|early(?: in the)? morning|early am)\b/i.test(text)) {
    setWindow(6 * 60, 9 * 60, "morning");
  } else if (/\b(?:late morning|before lunch)\b/i.test(text)) {
    setWindow(9 * 60 + 30, 12 * 60, "morning");
  } else if (/\b(?:morning|in the am|a\.m\.)\b/i.test(text)) {
    setWindow(6 * 60, 12 * 60, "morning");
  } else if (/\b(?:brunch|around lunch|lunchtime|lunch time|midday)\b/i.test(text)) {
    setWindow(11 * 60, 14 * 60, "midday");
  } else if (/\b(?:early afternoon|right after lunch)\b/i.test(text)) {
    setWindow(12 * 60, 15 * 60, "afternoon");
  } else if (/\b(?:late afternoon|later in the afternoon)\b/i.test(text)) {
    setWindow(15 * 60, 18 * 60, "afternoon");
  } else if (/\b(?:afternoon|in the pm|p\.m\.)\b/i.test(text)) {
    setWindow(12 * 60, 17 * 60, "afternoon");
  } else if (/\b(?:after work|after i get off|when i get off|after business hours|eod|end of day|end of the day|late in the day)\b/i.test(text)) {
    setWindow(16 * 60, 21 * 60, "evening");
  } else if (/\b(?:evening|tonight|this evening|this eve)\b/i.test(text)) {
    setWindow(16 * 60, 22 * 60, "evening");
  }

  const rangeMatch = timeText.match(/\b(?:between|from)\s+(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\s+(?:and|to|until|til|till|-)\s+(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\b/i) ||
    timeText.match(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\s*-\s*(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  if (rangeMatch) {
    const start = parseHourMinute(rangeMatch[1], rangeMatch[2], rangeMatch[3] || rangeMatch[6], timeText);
    const end = parseHourMinute(rangeMatch[4], rangeMatch[5], rangeMatch[6], timeText);
    if (start !== null && end !== null && end > start) {
      windowStartMinutes = start;
      windowEndMinutes = end + 1;
      targetMinutes = Math.round((start + end) / 2);
    }
  }

  const afterMatch = timeText.match(/\b(?:after|anytime after|sometime after|later than|no earlier than|not before)\s+(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  if (afterMatch) {
    const minutes = parseHourMinute(afterMatch[1], afterMatch[2], afterMatch[3], text);
    if (minutes !== null) {
      windowStartMinutes = minutes;
      windowEndMinutes = 24 * 60;
      targetMinutes = minutes;
    }
  }

  const beforeMatch = timeText.match(/\b(?:before|anytime before|sometime before|earlier than|no later than|not after|by)\s+(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  if (beforeMatch) {
    const minutes = parseHourMinute(beforeMatch[1], beforeMatch[2], beforeMatch[3], text);
    if (minutes !== null) {
      windowStartMinutes = 0;
      windowEndMinutes = minutes;
      targetMinutes = minutes;
    }
  }

  if (/\bafter lunch\b/i.test(text)) setWindow(13 * 60, 18 * 60, "afternoon");
  if (/\bbefore noon\b/i.test(text)) setWindow(6 * 60, 12 * 60, "morning");
  if (/\bafter noon\b/i.test(text)) setWindow(12 * 60, 18 * 60, "afternoon");
  if (/\bbefore work\b/i.test(text)) setWindow(5 * 60, 9 * 60, "morning");

  const relative = relativeHourPreference(timeText, timeZone, now);
  if (relative) {
    targetMinutes = relative.targetMinutes;
    toleranceMinutes = relative.toleranceMinutes;
  }

  const clock = clockPhraseMinutes(timeText);
  if (clock.minutes !== null && !rangeMatch) {
    targetMinutes = clock.minutes;
    toleranceMinutes = clock.toleranceMinutes;
    if (clock.toleranceMinutes === 0 && !afterMatch && !beforeMatch) {
      exactMinutes = clock.minutes;
    }
  }

  // Noon/midnight should behave as exact times even though they also carry a
  // useful day-part interpretation.
  if (/\b(?:noon|12\s*noon|high noon)\b/i.test(text)) {
    exactMinutes = 12 * 60;
    targetMinutes = 12 * 60;
    timeOfDay = timeOfDay || "midday";
  }
  if (/\b(?:midnight|12\s*midnight)\b/i.test(text)) {
    exactMinutes = 0;
    targetMinutes = 0;
  }

  return {
    timeOfDay,
    exactMinutes,
    targetMinutes,
    toleranceMinutes,
    windowStartMinutes,
    windowEndMinutes,
    raw: lower,
  };
};

export const formatTimePreferenceLabel = (preference = {}) => {
  const formatMinutes = (minutes) => {
    if (!Number.isFinite(minutes)) return "";
    const bounded = ((Math.floor(minutes) % (24 * 60)) + 24 * 60) % (24 * 60);
    const hour24 = Math.floor(bounded / 60);
    const minute = bounded % 60;
    const meridiem = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${String(minute).padStart(2, "0")} ${meridiem}`;
  };

  const exact = preference?.exactMinutes;
  const target = preference?.targetMinutes;
  const start = preference?.windowStartMinutes;
  const end = preference?.windowEndMinutes;
  const dayPart = normalizeText(preference?.timeOfDay);

  if (Number.isFinite(exact)) return formatMinutes(exact);
  if (Number.isFinite(target) && Number.isFinite(start) && start === target && end === 24 * 60) {
    return `after ${formatMinutes(target)}`;
  }
  if (Number.isFinite(target) && start === 0 && end === target) {
    return `before ${formatMinutes(target)}`;
  }
  if (dayPart && !Number.isFinite(target)) return dayPart;
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    const inclusiveEnd = Math.max(start, end - 1);
    return `between ${formatMinutes(start)} and ${formatMinutes(inclusiveEnd)}`;
  }
  if (Number.isFinite(target) && Number(preference?.toleranceMinutes || 0) > 0) {
    return `around ${formatMinutes(target)}`;
  }
  if (Number.isFinite(target)) return formatMinutes(target);
  return dayPart;
};

export const findTimeOfDay = (message) => parseTimePreference(message).timeOfDay;
export const findRequestedClockMinutes = (message) => parseTimePreference(message).exactMinutes;

export const localClockMinutes = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(date));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
};

export const filterSlotsByTimePreference = (slots, preference, timeZone) => {
  const list = Array.isArray(slots) ? slots : [];
  if (!preference) return list;

  return list.filter((slot) => {
    const minutes = localClockMinutes(slot.startAt, timeZone);
    if (!Number.isFinite(minutes)) return false;

    if (
      preference.windowStartMinutes !== null &&
      minutes < preference.windowStartMinutes
    ) return false;

    if (
      preference.windowEndMinutes !== null &&
      minutes >= preference.windowEndMinutes
    ) return false;

    if (preference.exactMinutes !== null) {
      return minutes === preference.exactMinutes;
    }

    if (
      preference.targetMinutes !== null &&
      Number(preference.toleranceMinutes || 0) > 0
    ) {
      return Math.abs(minutes - preference.targetMinutes) <= preference.toleranceMinutes;
    }

    return true;
  });
};

export const rankSlotsByTimePreference = (slots, preference, timeZone) => {
  const list = [...(Array.isArray(slots) ? slots : [])];
  if (!preference?.targetMinutes && preference?.targetMinutes !== 0) return list;
  return list.sort((a, b) => {
    const aMinutes = localClockMinutes(a.startAt, timeZone);
    const bMinutes = localClockMinutes(b.startAt, timeZone);
    const aDistance = Number.isFinite(aMinutes)
      ? Math.abs(aMinutes - preference.targetMinutes)
      : Number.POSITIVE_INFINITY;
    const bDistance = Number.isFinite(bMinutes)
      ? Math.abs(bMinutes - preference.targetMinutes)
      : Number.POSITIVE_INFINITY;
    return aDistance - bDistance;
  });
};

export const hasAppointmentPreferenceHint = (
  message,
  timeZone = "America/New_York",
  now = new Date(),
) => {
  const text = normalizeText(message);
  if (!text) return false;
  if (findDateRange(text, timeZone, now)) return true;

  const preference = parseTimePreference(text, timeZone, now);
  return Boolean(
    preference.timeOfDay ||
    preference.exactMinutes !== null ||
    preference.targetMinutes !== null ||
    preference.windowStartMinutes !== null ||
    preference.windowEndMinutes !== null
  );
};

export default {
  findDateRange,
  findTimeOfDay,
  findRequestedClockMinutes,
  parseTimePreference,
  formatTimePreferenceLabel,
  localClockMinutes,
  filterSlotsByTimePreference,
  rankSlotsByTimePreference,
  hasAppointmentPreferenceHint,
};
