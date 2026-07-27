const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_KEY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const getParts = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
};

export const assertTimeZone = (timeZone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    const error = new Error(`Invalid IANA timezone: ${timeZone}`);
    error.statusCode = 400;
    throw error;
  }
};

export const parseDateKey = (dateKey) => {
  const value = String(dateKey || "").trim();

  if (!DATE_KEY_PATTERN.test(value)) {
    const error = new Error("Dates must use YYYY-MM-DD format.");
    error.statusCode = 400;
    throw error;
  }

  const [year, month, day] = value.split("-").map(Number);
  const testDate = new Date(Date.UTC(year, month - 1, day));

  if (
    testDate.getUTCFullYear() !== year ||
    testDate.getUTCMonth() !== month - 1 ||
    testDate.getUTCDate() !== day
  ) {
    const error = new Error(`Invalid calendar date: ${value}`);
    error.statusCode = 400;
    throw error;
  }

  return { year, month, day, dateKey: value };
};

export const parseTimeKey = (timeKey) => {
  const value = String(timeKey || "").trim();
  const match = value.match(TIME_KEY_PATTERN);

  if (!match) {
    const error = new Error("Times must use 24-hour HH:mm format.");
    error.statusCode = 400;
    throw error;
  }

  return { hour: Number(match[1]), minute: Number(match[2]), timeKey: value };
};

export const zonedDateTimeToUtc = ({ dateKey, timeKey, timeZone }) => {
  assertTimeZone(timeZone);
  const { year, month, day } = parseDateKey(dateKey);
  const { hour, minute } = parseTimeKey(timeKey);
  const desiredUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = new Date(desiredUtcMs);

  /*
   * Intl does not expose a direct local-to-UTC constructor. Iteratively adjust
   * the candidate until its formatted wall-clock parts match the requested
   * business-local time. This works across normal DST offset changes.
   */
  for (let index = 0; index < 4; index += 1) {
    const parts = getParts(candidate, timeZone);
    const representedUtcMs = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
      0,
    );
    const difference = desiredUtcMs - representedUtcMs;

    if (difference === 0) {
      break;
    }

    candidate = new Date(candidate.getTime() + difference);
  }

  const roundTrip = getParts(candidate, timeZone);
  const isExact =
    Number(roundTrip.year) === year &&
    Number(roundTrip.month) === month &&
    Number(roundTrip.day) === day &&
    Number(roundTrip.hour) === hour &&
    Number(roundTrip.minute) === minute;

  if (!isExact) {
    const error = new Error(
      `The local time ${dateKey} ${timeKey} does not exist in ${timeZone}, likely because of a daylight-saving transition.`,
    );
    error.statusCode = 400;
    error.code = "NONEXISTENT_LOCAL_TIME";
    throw error;
  }

  return candidate;
};

export const formatDateKey = (date, timeZone) => {
  assertTimeZone(timeZone);
  const parts = getParts(new Date(date), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const formatTimeKey = (date, timeZone) => {
  assertTimeZone(timeZone);
  const parts = getParts(new Date(date), timeZone);
  return `${parts.hour}:${parts.minute}`;
};

export const formatZonedIso = (date, timeZone) => {
  const instant = new Date(date);
  const parts = getParts(instant, timeZone);
  const offsetName = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")?.value;

  const offsetMatch = String(offsetName || "GMT+00:00").match(
    /GMT([+-])(\d{2}):?(\d{2})?/,
  );
  const offset = offsetMatch
    ? `${offsetMatch[1]}${offsetMatch[2]}:${offsetMatch[3] || "00"}`
    : "+00:00";

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
};

export const addMinutes = (date, minutes) =>
  new Date(new Date(date).getTime() + Number(minutes || 0) * 60_000);

export const addDaysToDateKey = (dateKey, days) => {
  const { year, month, day } = parseDateKey(dateKey);
  const result = new Date(Date.UTC(year, month - 1, day + Number(days || 0)));

  return [
    result.getUTCFullYear(),
    String(result.getUTCMonth() + 1).padStart(2, "0"),
    String(result.getUTCDate()).padStart(2, "0"),
  ].join("-");
};

export const enumerateDateKeys = (startDate, endDate, maximumDays = 93) => {
  parseDateKey(startDate);
  parseDateKey(endDate);

  if (endDate < startDate) {
    const error = new Error("endDate must be on or after startDate.");
    error.statusCode = 400;
    throw error;
  }

  const values = [];
  let cursor = startDate;

  while (cursor <= endDate) {
    values.push(cursor);

    if (values.length > maximumDays) {
      const error = new Error(`Availability requests cannot exceed ${maximumDays} days.`);
      error.statusCode = 400;
      throw error;
    }

    cursor = addDaysToDateKey(cursor, 1);
  }

  return values;
};

export const getUtcDayOfWeekForDateKey = (dateKey) => {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
};

export const minutesFromTimeKey = (timeKey) => {
  const { hour, minute } = parseTimeKey(timeKey);
  return hour * 60 + minute;
};

export const timeKeyFromMinutes = (minutes) => {
  const value = Number(minutes);
  const hour = Math.floor(value / 60);
  const minute = value % 60;

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};
