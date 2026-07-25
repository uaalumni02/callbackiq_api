import crypto from "crypto";

const clean = (value) => String(value || "").trim();

const stableSerialize = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();

    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

const hashPayload = (payload) => {
  return crypto
    .createHash("sha256")
    .update(stableSerialize(payload || {}))
    .digest("hex");
};

export const buildTwilioEventIdentity = (eventType, body = {}) => {
  if (eventType === "inbound_sms") {
    const providerEventId =
      clean(body.MessageSid) || clean(body.SmsSid) || hashPayload(body);

    return {
      eventType,
      providerEventId,
      eventKey: `inbound_sms:${providerEventId}`,
    };
  }

  if (eventType === "inbound_voice") {
    const providerEventId = clean(body.CallSid) || hashPayload(body);

    return {
      eventType,
      providerEventId,
      eventKey: `inbound_voice:${providerEventId}`,
    };
  }

  if (eventType === "voice_status") {
    const callSid = clean(body.CallSid) || hashPayload(body);
    const callStatus = clean(body.CallStatus) || "unknown";
    const sequenceNumber = clean(body.SequenceNumber);

    return {
      eventType,
      providerEventId: callSid,
      eventKey: [
        "voice_status",
        callSid,
        callStatus,
        sequenceNumber,
      ]
        .filter(Boolean)
        .join(":"),
    };
  }

  if (eventType === "message_status") {
    const messageSid =
      clean(body.MessageSid) || clean(body.SmsSid) || hashPayload(body);

    const messageStatus =
      clean(body.MessageStatus) || clean(body.SmsStatus) || "unknown";

    return {
      eventType,
      providerEventId: messageSid,
      eventKey: `message_status:${messageSid}:${messageStatus}`,
    };
  }

  throw new Error(`Unsupported Twilio event type: ${eventType}`);
};

export const getTwilioStatusEventType = (body = {}) => {
  if (clean(body.MessageSid) || clean(body.SmsSid)) {
    return "message_status";
  }

  return "voice_status";
};
