// Original inbound lead projection, no outbound provider calls.
import {blocksServiceAutomation} from '../serviceEligibility/serviceEligibility.service.js';
import {VALID_URGENCIES,preserveHigherUrgency} from './urgencyPolicy.service.js';
export const buildLeadUpdates = (lead, result) => {
  const updates = { aiExtraction: { source: "customer_sms", observedAt: new Date(), verified: false } };
  const serviceNeeded = String(result?.serviceNeeded || "").trim();
  if (serviceNeeded && serviceNeeded !== "Unknown") updates.serviceNeeded = serviceNeeded;

  if (result?.messageCategory === "emergency") {
    updates.urgency = "emergency";
  } else if (VALID_URGENCIES.has(result?.urgency)) {
    const preservedUrgency = preserveHigherUrgency(
      lead?.urgency,
      result.urgency,
    );
    if (preservedUrgency !== lead?.urgency) {
      updates.urgency = preservedUrgency;
    }
  }

  for (const [field, value] of [
    ["address", result?.address],
    ["preferredAppointmentTime", result?.preferredAppointmentTime],
    ["summary", result?.summary],
  ]) {
    const normalized = String(value || "").trim();
    if (normalized) updates[field] = normalized;
  }

  const score = Number(result?.leadQualityScore ?? result?.score);
  if (Number.isFinite(score)) updates.leadQualityScore = Math.min(100, Math.max(0, score));
  if (blocksServiceAutomation(lead)) { updates.leadQualityScore = 0; updates.qualifiedAt = null; }
  if (!lead.firstRespondedAt) updates.firstRespondedAt = new Date();
  return updates;
};
