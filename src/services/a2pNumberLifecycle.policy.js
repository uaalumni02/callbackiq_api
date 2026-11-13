// Pure A2P number-lifecycle decisions. No persistence, provider, configuration,
// or clock access. Event processing and side effects remain in the onboarding service.
const clean = (value) => String(value ?? "").trim();
const upper = (value) => clean(value).toUpperCase();

export const parseEventDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== "") {
    // Twilio A2P schemas expose integer timestamps. Accept either Unix seconds
    // or milliseconds so schema-version differences cannot corrupt ordering.
    const millis = Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const numericDate = new Date(millis);
    return Number.isNaN(numericDate.getTime()) ? null : numericDate;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const resolveNumberLifecycleStatus = ({
  eventType = "",
  externalStatus = "",
} = {}) => {
  const type = clean(eventType).toLowerCase();
  const supplied = upper(externalStatus);
  const isDeregistration = type.includes("number-deregistration.");

  if (isDeregistration) {
    if (type.endsWith(".successful")) return "DEREGISTERED";
    if (type.endsWith(".pending")) return "PENDING_DEREGISTRATION";
    if (type.endsWith(".failed") || type.endsWith(".failure")) {
      return "DEREGISTRATION_FAILED";
    }
  }

  if (supplied) return supplied;
  if (type.endsWith(".successful")) return "REGISTERED";
  if (type.endsWith(".failed") || type.endsWith(".failure")) return "FAILURE";
  if (type.endsWith(".pending")) return "PENDING_REGISTRATION";
  return "PENDING_REGISTRATION";
};

export const numberLifecycleRank = (status) => {
  switch (upper(status)) {
    case "DEREGISTERED":
      return 100;
    case "FAILURE":
    case "FAILED":
      return 90;
    case "DEREGISTRATION_FAILED":
      return 96;
    case "REGISTERED":
      return 80;
    case "PENDING_DEREGISTRATION":
      return 95;
    default:
      return 10;
  }
};

export const shouldIgnoreNumberLifecycleEvent = ({
  lastEventId = "",
  lastEventAt = null,
  lastEventRank = 0,
  eventId = "",
  eventAt = null,
  eventRank = 0,
} = {}) => {
  if (eventId && lastEventId && eventId === lastEventId) return "duplicate";

  const incomingDate = parseEventDate(eventAt);
  const previousDate = parseEventDate(lastEventAt);

  if (incomingDate && previousDate) {
    if (incomingDate.getTime() < previousDate.getTime()) return "stale";
    if (
      incomingDate.getTime() === previousDate.getTime() &&
      Number(eventRank || 0) < Number(lastEventRank || 0)
    ) {
      return "stale";
    }
  } else if (
    !incomingDate &&
    Number(eventRank || 0) < Number(lastEventRank || 0)
  ) {
    // Fail closed when a malformed/missing timestamp would otherwise downgrade
    // a stronger terminal carrier state.
    return "stale";
  }

  return "";
};
