import crypto from "crypto";
import { markComplianceEvent } from "../services/a2pCustomerOnboarding.service.js";

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const authorized = (req) => {
  const expectedUser = String(process.env.A2P_EVENT_STREAM_USERNAME || "");
  const expectedPassword = String(process.env.A2P_EVENT_STREAM_PASSWORD || "");
  if (!expectedUser || !expectedPassword) return false;
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch (_error) {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return safeEqual(decoded.slice(0, separator), expectedUser) &&
    safeEqual(decoded.slice(separator + 1), expectedPassword);
};

const normalizeEvent = (event = {}) => ({
  type: String(event.type || event.eventType || ""),
  data: event.data || event.payload || {},
});

export const receiveA2pComplianceEvents = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ success: false, message: "Unauthorized." });
  const events = Array.isArray(req.body) ? req.body : [req.body];
  try {
    for (const raw of events.filter(Boolean)) {
      const event = normalizeEvent(raw);
      if (!event.type.startsWith("com.twilio.messaging.compliance.")) continue;
      await markComplianceEvent(event);
    }
    return res.status(204).send();
  } catch (error) {
    console.error("[a2p-events] compliance event failed", error);
    return res.status(500).json({ success: false, message: "Compliance event processing failed." });
  }
};
