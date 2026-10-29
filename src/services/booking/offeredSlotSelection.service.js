// Verbatim extracted selection policy. Keep provider and database IO outside this module.
import { findDateRange, parseTimePreference } from "./appointmentPreferenceParser.service.js";

export const spreadSlotOptions = (slots, maximum = 3) => {
  if (slots.length <= maximum) return slots;
  if (maximum <= 1) return [slots[0]];
  const indexes = Array.from({ length: maximum }, (_, index) =>
    Math.round((index * (slots.length - 1)) / (maximum - 1)),
  );
  return [...new Set(indexes)].map((index) => slots[index]);
};

export const selectSlotOptions = (slots, urgency = "medium", maximum = 3) => {
  const unique = new Map();
  for (const slot of Array.isArray(slots) ? slots : []) {
    const key = slot.arrivalStartAt ? String(slot.arrivalStartAt) : String(slot.startAt);
    if (!unique.has(key)) unique.set(key, slot);
  }
  const chronological = [...unique.values()].sort(
    (left, right) =>
      new Date(left.startAt).getTime() - new Date(right.startAt).getTime(),
  );

  return ["high", "emergency"].includes(String(urgency || "").toLowerCase())
    ? chronological.slice(0, maximum)
    : spreadSlotOptions(chronological, maximum);
};

export const selectOfferedSlot = (message, offeredSlots, timeZone) => {
  const text = String(message || "").trim().toLowerCase();
  if (/\b(?:not|no|don't|do not|can't|cannot|cancel)\b/i.test(text)) return null;
  if (offeredSlots.length === 1 && /^(?:yes|yeah|yep|that (?:time |option )?works(?: for me)?|works for me|sounds good|that one|the offered time)[.! ]*$/i.test(text)) return offeredSlots[0];
  // Option numbers are whole selections, never digits embedded in a clock time.
  const option = text.match(/^(?:(?:option|number|the)\s+)?(first|second|third|one|two|three|1|2|3)(?:\s+(?:one|option))?(?:\s+(?:please|works(?: for me)?))?[.! ]*$/);
  if (option) {
    const index = { first: 0, one: 0, "1": 0, second: 1, two: 1, "2": 1, third: 2, three: 2, "3": 2 }[option[1]];
    return offeredSlots[index] || null;
  }
  // Accept the exact offered label with a small acknowledgement suffix.
  // Substring matching can select negated labels or the wrong clock time.
  const normalizeLabel = value => String(value || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.! ]+$/, "");
  const labelReply = normalizeLabel(text).replace(/\s+(?:works(?: for me)?|please)$/, "");
  const labels = offeredSlots.filter(slot => normalizeLabel(slot.label) && normalizeLabel(slot.label) === labelReply);
  if (labels.length) return labels.length === 1 ? labels[0] : null;
  const clock = parseTimePreference(text, timeZone);
  const minutes = clock?.exactMinutes;
  if (!Number.isFinite(minutes)) return null;
  const range = findDateRange(text, timeZone, new Date());
  const matches = offeredSlots.filter((slot) => {
    const date = new Date(slot.startAt);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const fields = Object.fromEntries(parts.map(({type, value}) => [type, value]));
    const key = `${fields.year}-${fields.month}-${fields.day}`;
    return Number(fields.hour) * 60 + Number(fields.minute) === minutes &&
      (!range || (key >= range.startDate && key <= range.endDate));
  });
  return matches.length === 1 ? matches[0] : null;
};
