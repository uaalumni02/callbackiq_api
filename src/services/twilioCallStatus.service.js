import CallLog from "../models/callLog.js";
import SocketService from "./socket.service.js";

const CALL_STATUS_MAP = {
  "in-progress": "answered",
  answered: "answered",
  completed: "answered",
  busy: "busy",
  "no-answer": "no_answer",
  no_answer: "no_answer",
  failed: "failed",
  canceled: "failed",
};

const ALLOWED_CURRENT = {
  answered: ["missed", "answered"],
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
  const durationSeconds = Math.max(0, Number(payload.CallDuration || 0));
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
      },
      {
        $set: { status: canonicalStatus },
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
  if (callLog) SocketService.emitCallUpdated(businessId, callLog);
  return { callLog, providerStatus, canonicalStatus };
};

export default { processTwilioCallStatus };
