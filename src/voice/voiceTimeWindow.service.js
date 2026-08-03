/**
 * Pure operating-window helpers shared by voice routing and regression tests.
 * A window whose end is earlier than its start crosses midnight. A full-day
 * window must be explicit (`allDay: true` or 00:00-24:00), never inferred from
 * equal start/end values.
 */
export const timeToMinutes = (value, { allowEndOfDay = true } = {}) => {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours === 24 && minutes === 0 && allowEndOfDay) return 1440;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
};

export const windowKind = (window) => {
  if (window?.allDay === true) return "all_day";
  const start = timeToMinutes(window?.startTime, { allowEndOfDay: false });
  const end = timeToMinutes(window?.endTime);
  if (start == null || end == null || start === end) return "invalid";
  if (start === 0 && end === 1440) return "all_day";
  return end < start ? "overnight" : "same_day";
};

export const withinTimeWindow = (
  time,
  window,
  { previousDaySpillover = false } = {},
) => {
  const at = typeof time === "number" ? time : timeToMinutes(time);
  if (at == null) return false;

  const kind = windowKind(window);
  if (kind === "all_day") return !previousDaySpillover;
  if (kind === "invalid") return false;

  const start = timeToMinutes(window.startTime, { allowEndOfDay: false });
  const end = timeToMinutes(window.endTime);
  if (kind === "same_day") {
    return !previousDaySpillover && at >= start && at < end;
  }

  return previousDaySpillover ? at < end : at >= start;
};

export default { timeToMinutes, windowKind, withinTimeWindow };
