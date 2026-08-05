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
      "A text message is on its way now. Please reply with the service you need, " +
      "and the team will follow up.";
  } else if (status === "suppressed") {
    message =
      `Thank you for calling ${name}. We're sorry we missed you. ` +
      "We were unable to send a text to this number, but the team has been notified " +
      "and will follow up as soon as possible.";
  } else if (smsEnabled) {
    message =
      `Thank you for calling ${name}. We're sorry we missed you. ` +
      "We were unable to send the text, but the team has been notified and will " +
      "follow up as soon as possible.";
  } else {
    message =
      `Thank you for calling ${name}. We're sorry we missed you. ` +
      "The team has been notified and will follow up as soon as possible.";
  }

  return escapeXml(message);
};

export default buildSmsRecoveryVoicePrompt;
