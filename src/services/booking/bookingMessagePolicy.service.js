// Exact previous booking lexical rules. No provider calls or state writes.
import {hasAppointmentPreferenceHint} from './appointmentPreferenceParser.service.js';
export const BOOKING_INTENT = /\b(book|booking|schedule|appointment|available|availability|come out|visit)\b/i;
export const AVAILABILITY_HINT = /\b(today|tomorrow|tmrw|tmr|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|tonight|after work|next week|\d{1,2}(?::\d{2})?\s*(?:am|pm)|20\d{2}-\d{2}-\d{2})\b/i;
export const hasBookingAvailabilityHint = (value, timeZone = "America/New_York") =>
  AVAILABILITY_HINT.test(String(value || "")) ||
  hasAppointmentPreferenceHint(value, timeZone);
export const HUMAN_INTENT = /\b(human|person|representative|staff|someone|call me|talk to)\b/i;
export const AFFIRMATIVE_TOKEN = /\b(yes|yep|yeah|yup|correct|confirm|confirmed|book it|please do|that works|works for me|sounds good|ok|okay|sure)\b/i;
export const NEGATIVE_TOKEN = /\b(no|nope|not that|different|another|change it|cancel|do not|don't|not yet)\b/i;
export const EXACT_PRICE = /\b(exact|final|total)\b.{0,25}\b(price|cost|quote|charge)\b|\bhow much (?:will|does) it cost\b/i;
export const ZIP_PATTERN = /\b(\d{5})(?:-\d{4})?\b/;

export const isAffirmative = (value) => {
  const text = String(value || "").trim();
  return AFFIRMATIVE_TOKEN.test(text) && !NEGATIVE_TOKEN.test(text);
};

export const isNegative = (value) => NEGATIVE_TOKEN.test(String(value || "").trim());
