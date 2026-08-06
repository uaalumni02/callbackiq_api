const PROVIDER_ALIASES = Object.freeze({
  google: "google_calendar",
  google_calendar: "google_calendar",
  internal: "internal",
  jobber: "jobber",
  housecall_pro: "housecall_pro",
  servicetitan: "servicetitan",
});

export const normalizeCalendarProviderName = (
  value,
  fallback = "internal",
) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized) return fallback;
  return PROVIDER_ALIASES[normalized] || normalized;
};

export const businessCalendarProviderName = (business) =>
  normalizeCalendarProviderName(
    business?.features?.calendarProvider ||
      business?.featureSettings?.calendarProvider ||
      business?.integrations?.calendar?.provider,
  );

export default normalizeCalendarProviderName;
