import twilio from "twilio";
import { logOperationalWarning } from "../helpers/logging/safeLogger.js";
import { isUsableCallerId, normalizePhoneToE164 } from "./voicePhone.service.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();
let client = null;
let cachedSid = "";
let cachedToken = "";

const getClient = () => {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!accountSid || !authToken) return null;
  if (!client || accountSid !== cachedSid || authToken !== cachedToken) {
    client = twilio(accountSid, authToken);
    cachedSid = accountSid;
    cachedToken = authToken;
  }
  return client;
};

const normalizeLineType = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+(.)/g, (_match, character) => character.toUpperCase());

const classify = ({ phone, valid, lineType, source, errorCode = "" }) => {
  const normalizedType = normalizeLineType(lineType);
  const landline = ["landline", "pager", "voicemail"].includes(normalizedType);
  const smsCapable = ["mobile", "fixedVoip", "nonFixedVoip"].includes(
    normalizedType,
  );
  return {
    phone,
    valid: Boolean(valid),
    lineType: normalizedType || "unknown",
    landline,
    smsCapable,
    source,
    errorCode,
  };
};

class VoiceLineTypeService {
  static async lookup(phone) {
    const normalized = normalizePhoneToE164(phone);
    if (!isUsableCallerId(normalized)) {
      return classify({
        phone: "",
        valid: false,
        lineType: "unknown",
        source: "unusable_caller_id",
      });
    }

    const cached = cache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    if (process.env.VOICE_LOOKUP_LINE_TYPE_ENABLED !== "true") {
      return classify({
        phone: normalized,
        valid: true,
        lineType: "unknown",
        source: "lookup_disabled",
      });
    }

    const twilioClient = getClient();
    if (!twilioClient) {
      return classify({
        phone: normalized,
        valid: true,
        lineType: "unknown",
        source: "credentials_unavailable",
      });
    }

    try {
      const result = await twilioClient.lookups.v2
        .phoneNumbers(normalized)
        .fetch({ fields: "line_type_intelligence" });
      const lineType = result?.lineTypeIntelligence?.type || "unknown";
      const value = classify({
        phone: result?.phoneNumber || normalized,
        valid: result?.valid !== false,
        lineType,
        source: "twilio_lookup_v2",
        errorCode: result?.lineTypeIntelligence?.errorCode || "",
      });
      cache.set(normalized, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    } catch (error) {
      logOperationalWarning("voice.line_type_lookup_failed", {
        errorCode: error?.code || error?.name || "error",
      });
      return classify({
        phone: normalized,
        valid: true,
        lineType: "unknown",
        source: "lookup_failed",
        errorCode: error?.code || error?.name || "error",
      });
    }
  }

  static clearCache() {
    cache.clear();
    client = null;
    cachedSid = "";
    cachedToken = "";
  }
}

export default VoiceLineTypeService;
