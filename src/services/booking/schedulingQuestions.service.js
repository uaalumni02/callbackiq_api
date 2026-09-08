import { buildVerifiedBusinessFacts } from "../../helpers/ai/aiGuardrails.js";
import { isWaitlistInquiryText, isEmergencyAvailabilityText, isExplicitHumanRequestText } from "../scheduling/customerSchedulingIntent.service.js";

// Read-only answers must not advance a booking, erase a preference, or claim a write.
export const schedulingQuestionReply = ({ customerMessage, business, lead }) => {
  const text = String(customerMessage || "");
  if (isExplicitHumanRequestText(text) || /\b(?:cancel|reschedule)\s+(?:my|the)\s+(?:appointment|visit|booking)\b/i.test(text)) return null;
  const waitlist = isWaitlistInquiryText(text);
  const emergency = isEmergencyAvailabilityText(text);
  if (!waitlist && !emergency) return null;
  const parts = [];
  if (waitlist) {
    parts.push("I can’t enroll you in a managed waitlist here.");
    if (lead?.preferredAppointmentTime) parts.push("Your existing appointment preference stays unchanged.");
  }
  if (emergency) {
    const available = buildVerifiedBusinessFacts(business).emergencyServiceAvailable;
    parts.push(available === true
      ? "The business offers emergency service, but I can’t confirm an emergency opening or arrival time here."
      : available === false
        ? "The business does not offer emergency service."
        : "I don’t have verified emergency-service availability for this business.");
    const leak = /\bleak(?:ing|s)?\b/i.test(`${lead?.serviceNeeded || ""} ${text}`);
    parts.push(leak ? "Is water still leaking or spreading?" : "What is happening right now that needs urgent attention?");
  } else {
    parts.push("Would you like to check for an earlier appointment?");
  }
  return parts.join(" ");
};
