import { logOperationalEvent } from "../helpers/logging/safeLogger.js";
import CallLog from "../models/callLog.js";
import SocketService from "./socket.service.js";

// Only destination callbacks or an authenticated relay connection establish
// who answered. Parent completed/in-progress events are telemetry only.
const CALL_STATUS_MAP = {
  busy: "busy",
  "no-answer": "no_answer",
  no_answer: "no_answer",
  failed: "failed",
  canceled: "failed",
};

const ALLOWED_CURRENT = {
  busy: ["missed", "busy"],
  no_answer: ["missed", "no_answer"],
  failed: ["missed", "failed"],
};

const appendEvent = (event) => ({ $each: [event], $slice: -50 });

export const processTwilioCallStatus = async ({ businessId, payload = {} }) => {
  const providerCallId = String(payload.CallSid || "").trim();
  const providerStatus = String(payload.CallStatus || "").trim().toLowerCase();
  if (!businessId || !providerCallId || !providerStatus) return null;
  const canonicalStatus = CALL_STATUS_MAP[providerStatus] || "";
  const rawDuration = Number(payload.CallDuration || 0);
  const durationSeconds = Number.isFinite(rawDuration) ? Math.max(0, rawDuration) : 0;
  const eventBase = {
    providerStatus,
    canonicalStatus,
    durationSeconds,
    receivedAt: new Date(),
  };

  let callLog;
  if (!canonicalStatus) {
    callLog = await CallLog.findOneAndUpdate(
      { business: businessId, providerCallId },
      {
        $set: { providerStatus },
        $max: { durationSeconds },
        $push: {
          providerStatusEvents: appendEvent({
            ...eventBase,
            applied: false,
            conflict: false,
          }),
        },
      },
      { returnDocument: "after" },
    );
  } else {
    callLog = await CallLog.findOneAndUpdate(
      {
        business: businessId,
        providerCallId,
        status: { $in: ALLOWED_CURRENT[canonicalStatus] || [] },
        disposition: { $nin: ["answered_by_business", "answered_by_ai"] },
      },
      {
        $set: { providerStatus, status: canonicalStatus, disposition: canonicalStatus },
        $max: { durationSeconds },
        $push: {
          providerStatusEvents: appendEvent({
            ...eventBase,
            applied: true,
            conflict: false,
          }),
        },
      },
      { returnDocument: "after" },
    );
    if (!callLog) {
      callLog = await CallLog.findOneAndUpdate(
        { business: businessId, providerCallId },
        {
          $push: {
            providerStatusEvents: appendEvent({
              ...eventBase,
              applied: false,
              conflict: true,
            }),
          },
        },
        { returnDocument: "after" },
      );
    }
  }
  if (!callLog) logOperationalEvent("twilio.status.unknown_call", { businessId, providerCallId, providerStatus });
  if (callLog) SocketService.emitCallUpdated(businessId, callLog);
  return { callLog, providerStatus, canonicalStatus };
};

export default { processTwilioCallStatus };
