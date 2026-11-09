import { validateTwilioRequestWithRotation } from "../services/twilioSignatureRotation.service.js";
import { getVoiceWebSocketUrl } from "./voiceRouting.service.js";

export const PATH = "/ws/voice";

const signatureUrlForRequest = (request) => {
  const configured = getVoiceWebSocketUrl();
  if (!configured) return "";
  try {
    const publicUrl = new URL(configured);
    const requestUrl = new URL(request.url || PATH, "http://localhost");
    publicUrl.pathname = requestUrl.pathname;
    publicUrl.search = requestUrl.search;
    publicUrl.hash = "";
    return publicUrl.toString();
  } catch {
    return configured;
  }
};

export const validateConversationRelaySignature = (request) => {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.DISABLE_TWILIO_SIGNATURE_VALIDATION === "true"
  ) {
    return true;
  }

  const signature = request.headers?.["x-twilio-signature"];
  const publicUrl = signatureUrlForRequest(request);

  if (!signature || !publicUrl) return false;

  return validateTwilioRequestWithRotation({
    signature,
    url: publicUrl,
    params: {},
  });
};
