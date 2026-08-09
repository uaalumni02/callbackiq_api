import crypto from "crypto";

const DEFAULT_TIME_ZONE = "America/New_York";
const DEFAULT_DURATION_MINUTES = 15;
const DEFAULT_START_HOUR = 9;
const DEFAULT_END_HOUR = 17;
const DEFAULT_LEAD_MINUTES = 120;
const DEFAULT_HORIZON_DAYS = 14;
const DEFAULT_BOOKING_DAYS = [1, 2, 3, 4, 5];

const intFromEnv = (value, fallback, { min = 0, max = 10000 } = {}) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const parseBookingDays = (value) => {
  if (!value) return DEFAULT_BOOKING_DAYS;

  const parsed = String(value)
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);

  return parsed.length ? [...new Set(parsed)] : DEFAULT_BOOKING_DAYS;
};

export const getDemoSchedulingConfig = () => ({
  timeZone: String(process.env.DEMO_TIMEZONE || DEFAULT_TIME_ZONE).trim(),
  durationMinutes: intFromEnv(
    process.env.DEMO_SLOT_DURATION_MINUTES,
    DEFAULT_DURATION_MINUTES,
    { min: 10, max: 120 },
  ),
  startHour: intFromEnv(
    process.env.DEMO_BOOKING_START_HOUR,
    DEFAULT_START_HOUR,
    { min: 0, max: 23 },
  ),
  endHour: intFromEnv(
    process.env.DEMO_BOOKING_END_HOUR,
    DEFAULT_END_HOUR,
    { min: 1, max: 24 },
  ),
  leadMinutes: intFromEnv(
    process.env.DEMO_BOOKING_LEAD_MINUTES,
    DEFAULT_LEAD_MINUTES,
    { min: 0, max: 10080 },
  ),
  horizonDays: intFromEnv(
    process.env.DEMO_BOOKING_HORIZON_DAYS,
    DEFAULT_HORIZON_DAYS,
    { min: 1, max: 60 },
  ),
  bookingDays: parseBookingDays(process.env.DEMO_BOOKING_DAYS),
  meetingUrl: String(process.env.DEMO_MEETING_URL || "").trim(),
});

const getFormatter = (timeZone) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

export const getZonedParts = (date, timeZone) => {
  const parts = getFormatter(timeZone).formatToParts(date);
  const result = {};

  parts.forEach((part) => {
    if (part.type !== "literal") {
      result[part.type] = Number.parseInt(part.value, 10);
    }
  });

  return {
    year: result.year,
    month: result.month,
    day: result.day,
    hour: result.hour,
    minute: result.minute,
    second: result.second,
  };
};

export const zonedTimeToUtc = (parts, timeZone) => {
  const desiredUtcEpoch = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
  );

  let candidate = new Date(desiredUtcEpoch);

  // Two passes handle ordinary DST offsets without adding another dependency.
  for (let pass = 0; pass < 3; pass += 1) {
    const observed = getZonedParts(candidate, timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const correction = desiredUtcEpoch - observedAsUtc;

    if (correction === 0) break;
    candidate = new Date(candidate.getTime() + correction);
  }

  return candidate;
};

const localDateSerial = ({ year, month, day }) =>
  Math.floor(Date.UTC(year, month - 1, day) / 86400000);

const addLocalDays = ({ year, month, day }, days) => {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
};

const localDayOfWeek = ({ year, month, day }) =>
  new Date(Date.UTC(year, month - 1, day)).getUTCDay();

const overlaps = (startA, endA, startB, endB) =>
  startA < endB && endA > startB;

export const createBookingToken = () =>
  crypto.randomBytes(32).toString("base64url");

export const hashBookingToken = (token) =>
  crypto.createHash("sha256").update(String(token || "")).digest("hex");

export const isBookingTokenValid = (record, token) => {
  const storedHash = String(record?.bookingTokenHash || "");
  if (!storedHash || !token) return false;

  const providedHash = hashBookingToken(token);
  const left = Buffer.from(storedHash, "hex");
  const right = Buffer.from(providedHash, "hex");

  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

export const getSlotKey = (scheduledAt) =>
  new Date(scheduledAt).toISOString();

export const isAllowedDemoSlot = (
  scheduledAt,
  { now = new Date(), config = getDemoSchedulingConfig() } = {},
) => {
  const start = new Date(scheduledAt);
  if (Number.isNaN(start.getTime())) return false;

  const earliest = new Date(now.getTime() + config.leadMinutes * 60000);
  if (start < earliest) return false;

  const startParts = getZonedParts(start, config.timeZone);
  const nowParts = getZonedParts(now, config.timeZone);
  const daysAhead =
    localDateSerial(startParts) - localDateSerial(nowParts);

  if (daysAhead < 0 || daysAhead > config.horizonDays) return false;
  if (!config.bookingDays.includes(localDayOfWeek(startParts))) return false;

  const minutesFromMidnight = startParts.hour * 60 + startParts.minute;
  const bookingStart = config.startHour * 60;
  const bookingEnd = config.endHour * 60;
  const duration = config.durationMinutes;

  if (minutesFromMidnight < bookingStart) return false;
  if (minutesFromMidnight + duration > bookingEnd) return false;
  if ((minutesFromMidnight - bookingStart) % duration !== 0) return false;
  if (startParts.second !== 0) return false;

  return true;
};

export const buildDemoScheduleUpdate = (
  scheduledAt,
  { config = getDemoSchedulingConfig() } = {},
) => {
  const start = new Date(scheduledAt);
  const end = new Date(
    start.getTime() + config.durationMinutes * 60000,
  );

  return {
    status: "scheduled",
    scheduledAt: start,
    scheduledEndAt: end,
    timezone: config.timeZone,
    slotKey: getSlotKey(start),
    ...(config.meetingUrl ? { meetingUrl: config.meetingUrl } : {}),
    cancelledAt: null,
  };
};

export const assertDemoSlotAvailable = async (
  DemoRequest,
  scheduledAt,
  {
    now = new Date(),
    excludeDemoId = null,
    config = getDemoSchedulingConfig(),
  } = {},
) => {
  if (!isAllowedDemoSlot(scheduledAt, { now, config })) {
    const error = new Error(
      "That demo time is outside the available booking window.",
    );
    error.code = "DEMO_SLOT_INVALID";
    throw error;
  }

  const start = new Date(scheduledAt);
  const end = new Date(start.getTime() + config.durationMinutes * 60000);

  const query = {
    status: "scheduled",
    scheduledAt: { $lt: end },
    scheduledEndAt: { $gt: start },
  };

  if (excludeDemoId) {
    query._id = { $ne: excludeDemoId };
  }

  const conflict = await DemoRequest.findOne(query).lean();

  if (conflict) {
    const error = new Error(
      "That demo time was just booked. Please choose another time.",
    );
    error.code = "DEMO_SLOT_TAKEN";
    throw error;
  }

  return buildDemoScheduleUpdate(start, { config });
};

export const getDemoAvailability = async (
  DemoRequest,
  { now = new Date(), excludeDemoId = null, config = getDemoSchedulingConfig() } = {},
) => {
  const nowParts = getZonedParts(now, config.timeZone);
  const lastLocalDate = addLocalDays(nowParts, config.horizonDays + 1);
  const rangeEnd = zonedTimeToUtc(
    {
      ...lastLocalDate,
      hour: 23,
      minute: 59,
      second: 59,
    },
    config.timeZone,
  );

  const query = {
    status: "scheduled",
    scheduledAt: { $lt: rangeEnd },
    scheduledEndAt: { $gt: now },
  };

  if (excludeDemoId) {
    query._id = { $ne: excludeDemoId };
  }

  const booked = await DemoRequest.find(query)
    .select("scheduledAt scheduledEndAt")
    .lean();

  const earliest = new Date(now.getTime() + config.leadMinutes * 60000);
  const slots = [];

  for (let dayOffset = 0; dayOffset <= config.horizonDays; dayOffset += 1) {
    const localDate = addLocalDays(nowParts, dayOffset);

    if (!config.bookingDays.includes(localDayOfWeek(localDate))) {
      continue;
    }

    const bookingStartMinutes = config.startHour * 60;
    const bookingEndMinutes = config.endHour * 60;

    for (
      let minuteOfDay = bookingStartMinutes;
      minuteOfDay + config.durationMinutes <= bookingEndMinutes;
      minuteOfDay += config.durationMinutes
    ) {
      const hour = Math.floor(minuteOfDay / 60);
      const minute = minuteOfDay % 60;
      const start = zonedTimeToUtc(
        {
          ...localDate,
          hour,
          minute,
          second: 0,
        },
        config.timeZone,
      );
      const end = new Date(
        start.getTime() + config.durationMinutes * 60000,
      );

      if (start < earliest) continue;

      const isBooked = booked.some((item) => {
        const bookedStart = new Date(item.scheduledAt);
        const bookedEnd = new Date(
          item.scheduledEndAt ||
            bookedStart.getTime() + config.durationMinutes * 60000,
        );

        return overlaps(start, end, bookedStart, bookedEnd);
      });

      if (!isBooked) {
        slots.push({
          start: start.toISOString(),
          end: end.toISOString(),
        });
      }
    }
  }

  return {
    timezone: config.timeZone,
    durationMinutes: config.durationMinutes,
    horizonDays: config.horizonDays,
    slots,
  };
};

export default {
  getDemoSchedulingConfig,
  createBookingToken,
  hashBookingToken,
  isBookingTokenValid,
  getSlotKey,
  isAllowedDemoSlot,
  buildDemoScheduleUpdate,
  assertDemoSlotAvailable,
  getDemoAvailability,
};
