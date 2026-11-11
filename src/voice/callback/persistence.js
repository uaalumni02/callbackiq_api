import "../../services/booking/customerAddress.service.js";
import "../../services/messaging/ownerTextPolicy.service.js";
import "../../services/staffReviewPolicy.service.js";
import mongoose from "mongoose";
import "../../models/alert.js";
import "../../models/message.js";
import VoiceSession from "../../models/voiceSession.js";
import { logOperationalWarning } from "../../helpers/logging/safeLogger.js";
import "../../helpers/ai/tools/validateServiceArea.tool.js";
import SocketService from "../../services/socket.service.js";
import "../../services/twilioSmsService.js";
import "../../services/customerCommitmentSafety.service.js";
import "../voiceAvailability.service.js";
import "../voiceInput.service.js";
import "../voiceLineType.service.js";
import "../voiceMetrics.service.js";
import { isUsableCallerId } from "../voicePhone.service.js";
import { assertVoiceTurnActive } from "../../services/voiceTurnContext.service.js";
import { clean, ACTIVE_STATUSES, skippedValue, appendText, normalizeId } from './policy.js';
import { validFieldValue } from './state.js';

const emit = (method, ...args) => {
  try {
    if (typeof SocketService?.[method] === "function") {
      SocketService[method](...args);
    }
  } catch (error) {
    logOperationalWarning("voice.callback_socket_event_failed", {
      method,
      errorCode: error?.code || error?.name || "error",
    });
  }
};

const setLocalPath = (target, path, value) => {
  const parts = String(path || "").split(".").filter(Boolean);
  if (!target || parts.length === 0) return;
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    const existing = cursor[key];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[parts.at(-1)] = value;
};

const persistSessionSet = async (session, set = {}) => {
  if (!session) return null;

  for (const [path, value] of Object.entries(set)) {
    setLocalPath(session, path, value);
  }

  // Production voice-session documents always use ObjectIds. Several established
  // unit and completion suites intentionally use lightweight string IDs and mocked
  // documents. Persist those through the supplied document's save method instead
  // of sending an invalid ID through Mongoose's ObjectId caster.
  if (session._id && mongoose.isValidObjectId(session._id)) {
    return VoiceSession.findByIdAndUpdate(
      session._id,
      { $set: set },
      { returnDocument: "after" },
    );
  }

  if (typeof session.save === "function") {
    await session.save();
  }
  return session;
};

const leadFields = { serviceNeeded: 'serviceNeeded', customerName: 'customerName', location: 'address', preferredTime: 'preferredAppointmentTime' };

const leadSnapshot = session => Object.fromEntries(Object.entries(leadFields).map(([key, field]) => [key, clean(session.lead?.[field], 500)]));

const reconcileLead = (session, state) => {
  const current = leadSnapshot(session);
  let changed = false;
  for (const [key, value] of Object.entries(current)) {
    const field = { serviceNeeded: 'service', customerName: 'name', location: 'location', preferredTime: 'preference' }[key];
    if (state.leadSnapshot?.[key] && !value && state[key]) {
      state[key] = ''; changed = true; continue;
    }
    // Legacy callback states have no baseline: retain a more complete durable
    // field until the caller explicitly corrects it in this flow.
    if (value && !/^(?:unknown|voice caller|not provided)$/i.test(value) &&
        (!state.leadSnapshot || value !== state.leadSnapshot[key]) && state[key] !== value &&
        validFieldValue({ ...state, [key]: value }, field)) {
      state[key] = value; changed = true;
    }
  }
  return changed;
};

const saveState = async (session, state, status = "capturing_callback") => {
  assertVoiceTurnActive();
  const persistedStatus = ["completed", "canceled"].includes(state.status)
    ? status
    : "capturing_callback";
  if (ACTIVE_STATUSES.has(state.status) && session.lead?.save) {
    let changed = false;
    for (const [key, field] of Object.entries(leadFields)) {
      const label = { serviceNeeded: 'service', customerName: 'name', location: 'location', preferredTime: 'preference' }[key];
      if (validFieldValue(state, label) && !skippedValue(state[key]) && state[key] !== session.lead[field]) {
        session.lead[field] = state[key]; changed = true;
      }
    }
    if (changed) { assertVoiceTurnActive(); await session.lead.save(); assertVoiceTurnActive(); }
  }
  state.leadSnapshot = leadSnapshot(session);
  session.metadata = { ...(session.metadata || {}), callbackCapture: state };
  session.lastActivityAt = new Date();
  if (!["completed", "failed", "canceled"].includes(session.status)) {
    session.status = persistedStatus;
  }
  await persistSessionSet(session, {
    "metadata.callbackCapture": state,
    lastActivityAt: session.lastActivityAt,
    status: session.status,
  });
};

const updateLead = async ({ session, state, canceled = false }) => {
  assertVoiceTurnActive();
  const lead = session?.lead;
  if (!lead || typeof lead.save !== "function") return;
  if (state.customerName && !skippedValue(state.customerName)) {
    lead.customerName = state.customerName;
  }
  if (state.serviceNeeded && !skippedValue(state.serviceNeeded)) {
    lead.serviceNeeded = state.serviceNeeded;
  }
  if (state.location && !skippedValue(state.location)) lead.address = state.location;
  if (state.preferredTime && !skippedValue(state.preferredTime)) {
    lead.preferredAppointmentTime = state.preferredTime;
  }
  if (state.phone && isUsableCallerId(state.phone)) lead.phone = state.phone;
  if (state.urgency) lead.urgency = state.urgency;
  lead.status = lead.status || "new";
  lead.firstRespondedAt = lead.firstRespondedAt || new Date();
  if (!canceled) {
    lead.summary = clean(
      `Voice callback requested. Service: ${state.serviceNeeded || "Not provided"}. Location: ${state.location || "Not provided"}. Urgency: ${state.urgencyDetail || state.urgency || "Not provided"}. Preferred time: ${state.preferredTime || "Not provided"}.`,
      1000,
    );
  }
  lead.notes = appendText(
    lead.notes,
    canceled
      ? `CallBackIQ voice callback capture (${state.reason}) was canceled by the caller at ${new Date().toISOString()}. Partial details were retained.`
      : `CallBackIQ voice callback capture (${state.reason}) was confirmed at ${new Date().toISOString()}.`,
    2000,
  );
  await lead.save();
  emit("emitLeadUpdated", normalizeId(session.business), lead);
};

const updateConversation = async ({ session, state, canceled = false }) => {
  assertVoiceTurnActive();
  const conversation = session?.conversation;
  if (!conversation || typeof conversation.save !== "function") return;
  if (state.phone && isUsableCallerId(state.phone)) {
    conversation.customerPhone = state.phone;
  }
  if (state.customerName && !skippedValue(state.customerName)) {
    conversation.customerName = state.customerName;
  }

  if (!canceled) {
    // A captured request means the team was alerted; it does not mean a person
    // accepted ownership. Preserve AI/SMS eligibility until a real staff action.
    if (conversation.humanTakeover !== true) {
      setLocalPath(conversation, "orchestration.phase", "handoff_pending");
    }
    setLocalPath(conversation, "orchestration.handoffStatus", "acknowledged");
    setLocalPath(conversation, "orchestration.handoffReason", state.reason);
    setLocalPath(
      conversation,
      "orchestration.handoffRequestedAt",
      conversation?.orchestration?.handoffRequestedAt || new Date(),
    );
    setLocalPath(conversation, "orchestration.handoffAcknowledgedAt", new Date());
    setLocalPath(
      conversation,
      "orchestration.handoffCallbackPhone",
      state.phone && isUsableCallerId(state.phone) ? state.phone : "",
    );
  }
  conversation.lastMessage = canceled
    ? "Caller canceled voice callback capture. Partial details were preserved."
    : "CallBackIQ captured and flagged a voice callback request for team review.";
  conversation.lastMessageAt = new Date();
  await conversation.save();
  emit("emitConversationUpdated", normalizeId(session.business), conversation);
};

export { emit, setLocalPath, persistSessionSet, leadFields, leadSnapshot, reconcileLead, saveState, updateLead, updateConversation };
