import { schedulingEvidence } from './schedulingEvidence.service.js';
import { extractCustomerAddress } from "./customerAddress.service.js";
import { findDateRange, parseTimePreference } from "./appointmentPreferenceParser.service.js";

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const known = (value) => clean(value) && !/^(unknown|not provided|n\/a)$/i.test(clean(value));

/*
 * A safety reply takes priority over intake, but it must not throw away what
 * the customer already told us. This is a pure, read-only extractor: it never
 * replies, books, or persists. The caller merges the non-empty fields into the
 * lead so the customer is not asked to repeat an address or a requested time
 * after an emergency (or a false alarm) interrupts the conversation.
 */
export const captureTurnFacts = ({ customerMessage, classification = null, lead = null, business = null, now = new Date() } = {}) => {
  const text = clean(customerMessage);
  if (!text) return {};
  const timezone = business?.timezone || "America/New_York";
  const facts = {};

  const address = extractCustomerAddress(text);
  if (address) facts.address = address;

  const service = clean(classification?.entities?.serviceNeeded).slice(0, 160);
  if (known(service) && (!known(lead?.serviceNeeded) || classification?.intents?.correction || classification?.intents?.newService)) {
    facts.serviceNeeded = service;
  }

  try {
    const schedulingText = address ? clean(text.replace(address, "")) : text;
    const range = findDateRange(schedulingText, timezone, now);
    const time = parseTimePreference(schedulingText, timezone, now);
    const priorRange = findDateRange(lead?.preferredAppointmentTime || '', timezone, now);
    const priorTime = parseTimePreference(lead?.preferredAppointmentTime || '', timezone, now);
    const evidence = schedulingEvidence(schedulingText);
    const resolvedRange = range || (evidence.rejectedDate ? null : priorRange);
    const resolvedTime = time?.targetMinutes !== null || time?.timeOfDay ? time : evidence.rejectedTime ? null : priorTime;
    const date = resolvedRange
      ? resolvedRange.startDate === resolvedRange.endDate ? resolvedRange.startDate : `${resolvedRange.startDate} through ${resolvedRange.endDate}`
      : "";
    const hasTime = resolvedTime && (resolvedTime.targetMinutes !== null || resolvedTime.timeOfDay);
    const timeLabel = hasTime
      ? resolvedTime.exactMinutes !== null
        ? `${Math.floor(resolvedTime.exactMinutes / 60)}:${String(resolvedTime.exactMinutes % 60).padStart(2, "0")}`
        : clean(resolvedTime.raw).slice(0, 300)
      : "";
    if ((range || time?.targetMinutes !== null || time?.timeOfDay) && (date || timeLabel)) facts.preferredAppointmentTime = [date, timeLabel].filter(Boolean).join(" at ");
  } catch {
    // Timing is optional evidence; never let parsing block a safety reply.
  }
  return facts;
};

export default { captureTurnFacts };
