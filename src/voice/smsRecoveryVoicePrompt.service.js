import { normalizeEmergencyNumberForSpeech } from "./voiceSpeech.service.js";
import { sanitizeUnverifiedStaffCommitments } from "../services/customerCommitmentSafety.service.js";
const escapeXml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const normalizeBusinessName = (businessName) => {
  const normalized = String(businessName || "").trim();
  return normalized || "the business";
};

/**
 * Builds the spoken confirmation used when a call follows the SMS-recovery path.
 *
 * The returned value is XML-safe for direct use inside a Twilio <Say> element.
 * It only promises an incoming text after the SMS provider has accepted the send.
 */
export const buildSmsRecoveryVoicePrompt = ({
  businessName,
  smsEnabled = false,
  smsStatus = "disabled",
} = {}) => {
  const name = normalizeBusinessName(businessName);
  const status = String(smsStatus || "").trim().toLowerCase();

  let message;

  if (status === "sent") {
    message =
      `Thank you for calling ${name}. We're sorry we missed you. ` +
      "A text message is on its way now. Please reply with the service you need. " +
      "A team member may respond when available, but response timing is not guaranteed.";
  } else if (status === "queued") {
    message = `Thank you for calling ${name}. We’re sorry we missed you. ` +
      "Your missed call has been recorded. If a recovery text reaches you, please reply with the service you need. " +
      "Staff response timing is not guaranteed.";
  } else if (status === "suppressed") {
    message =
      `Thank you for calling ${name}. We're sorry we missed you. ` +
      "We were unable to send a text to this number. " +
      "A team member may respond when available, but response timing is not guaranteed.";
  } else if (smsEnabled) {
    message =
      `Thank you for calling ${name}. We're sorry we missed you. ` +
      "We were unable to send the text. " +
      "A team member may respond when available, but response timing is not guaranteed.";
  } else {
    message =
      `Thank you for calling ${name}. We're sorry we missed you. ` +
      "Text recovery is not available for this call. " +
      "A team member may respond when available, but response timing is not guaranteed.";
  }

  message += " This service does not monitor emergencies or dispatch emergency help. For immediate danger, call 911.";

  const safeMessage = sanitizeUnverifiedStaffCommitments(
    String(message ?? ""),
    { channel: "voice" },
  )
    .replace(
      /\b(?:the\s+)?team\s+has\s+been\s+notified\s+and\s+will\s+follow\s+up(?:\s+as\s+soon\s+as\s+possible)?\b/gi,
      "your missed call has been recorded for the business; staff response timing is not guaranteed",
    )
    .replace(
      /\band\s+(?:the\s+)?team\s+will\s+follow\s+up(?:\s+as\s+soon\s+as\s+possible)?\b/gi,
      "and staff response timing is not guaranteed",
    )
    .replace(
      /\b(?:the\s+)?team\s+will\s+follow\s+up(?:\s+as\s+soon\s+as\s+possible)?\b/gi,
      "staff response timing is not guaranteed",
    )
    .replace(
      /\bwill\s+follow\s+up(?:\s+as\s+soon\s+as\s+possible)?\b/gi,
      "staff response timing is not guaranteed",
    )
    .replace(
      /\bwill\s+(?:call|contact)\b/gi,
      "may respond when staff are available",
    );

  return escapeXml(normalizeEmergencyNumberForSpeech(safeMessage));
};

export default buildSmsRecoveryVoicePrompt;
