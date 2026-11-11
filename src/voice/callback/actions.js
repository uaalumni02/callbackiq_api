import "../../services/booking/customerAddress.service.js";
import "../../services/messaging/ownerTextPolicy.service.js";
import "../../services/staffReviewPolicy.service.js";
import "mongoose";
import "../../models/alert.js";
import "../../models/message.js";
import "../../models/voiceSession.js";
import "../../helpers/logging/safeLogger.js";
import validateServiceAreaTool from "../../helpers/ai/tools/validateServiceArea.tool.js";
import "../../services/socket.service.js";
import "../../services/twilioSmsService.js";
import { sanitizeUnverifiedStaffCommitments } from "../../services/customerCommitmentSafety.service.js";
import VoiceAvailabilityService from "../voiceAvailability.service.js";
import { extractCallbackDetails, isBusinessHoursQuestion, isPlausibleCallbackName, isServiceAreaQuestion, isSkipIntent, toSpokenReply } from "../voiceInput.service.js";
import "../voiceLineType.service.js";
import "../voiceMetrics.service.js";
import { isUsableCallerId, speakDigits } from "../voicePhone.service.js";
import { assertVoiceTurnActive } from "../../services/voiceTurnContext.service.js";
import { endPacket, clean, normalizeId, ALL_FIELDS, promptFor } from './policy.js';
import { updateLead, updateConversation, saveState, persistSessionSet, emit } from './persistence.js';
import { createCallbackAlert, sendCallbackConfirmation } from './notifications.js';
import { markSkipped, applyExtractedDetails, validFieldValue, setStateValue } from './state.js';

const buildReadback = (state) => {
  const details = [
    `service: ${state.serviceNeeded || "not provided"}`,
    `name: ${state.customerName || "not provided"}`,
    `location: ${state.location || "not provided"}`,
    `urgency: ${state.urgencyDetail || state.urgency || "not provided"}`,
    `preferred timing: ${state.preferredTime || "not provided"}`,
  ];
  if (state.phone && isUsableCallerId(state.phone)) {
    details.push(`callback number: ${speakDigits(state.phone)}`);
  } else {
    details.push("callback number: not available");
  }
  return toSpokenReply(
    `Here is what I have. ${details.join("; ")}. Is that correct? Say yes, or tell me which detail to change.`,
  );
};

const complete = async ({
  session,
  state,
  reply,
  sendConfirmationSms = true,
}) => {
  assertVoiceTurnActive();
  if (state.completedAt) {
    return {
      reply: reply || "Your callback request was already saved.",
      handoff: endPacket("callback-captured", state.reason),
      callbackCaptured: true,
      outcome: state.priority === "critical" ? "safety_escalated" : "callback_saved",
    };
  }

  await updateLead({ session, state });
  await createCallbackAlert({ session, state });
  // Record completion only after the durable alert succeeds, so a failed write
  // cannot make a retry skip the handoff or claim it was acknowledged.
  await updateConversation({ session, state });
  state.status = "completed";
  state.currentField = "";
  state.completedAt = new Date().toISOString();
  if (sendConfirmationSms) await sendCallbackConfirmation({ session, state });

  session.transferredToHuman = false;
  session.transferReason = `callback_captured:${state.reason}`.slice(0, 1000);
  session.summary = clean(
    `Callback captured. Service: ${state.serviceNeeded || "Not provided"}. Location: ${state.location || "Not provided"}. Urgency: ${state.urgencyDetail || state.urgency || "Not provided"}. Preferred time: ${state.preferredTime || "Not provided"}.`,
    4000,
  );
  session.status = state.priority === "critical" ? "safety_escalated" : "completing";
  await saveState(session, state, session.status);
  await persistSessionSet(session, {
    transferredToHuman: false,
    transferReason: session.transferReason,
    summary: session.summary,
    status: session.status,
  });
  emit("emitDashboardRefresh", normalizeId(session.business), "voice_callback_captured");

  const confirmationMessage =
    state.confirmationSmsStatus === "sent"
      ? " I also sent a confirmation text."
      : state.confirmationSmsStatus === "failed"
        ? " The request was saved even though the confirmation text could not be sent."
        : state.confirmationSmsStatus === "suppressed" && state.lineType === "landline"
          ? " This number appears to be a landline, so I did not promise a text confirmation."
          : "";
  const noPhone = !state.phone || !isUsableCallerId(state.phone);
  const safeReply = sanitizeUnverifiedStaffCommitments(
    reply ||
      (noPhone
        ? "I saved the information for review, but I cannot promise a callback because no usable phone number was confirmed."
        : `Thank you. I created a priority callback request.${confirmationMessage} I can't guarantee when someone will be available to call, but your confirmed details are preserved for the team.`),
    { channel: "voice" },
  );
  return {
    reply: safeReply,
    handoff: endPacket("callback-captured", state.reason),
    callbackCaptured: true,
    outcome: state.priority === "critical" ? "safety_escalated" : "callback_saved",
  };
};

const cancelCapture = async ({ session, state }) => {
  state.status = "canceled";
  state.currentField = "";
  state.canceledAt = new Date().toISOString();
  await updateLead({ session, state, canceled: true });
  await updateConversation({ session, state, canceled: true });
  await createCallbackAlert({ session, state, canceled: true });
  session.status = "canceled";
  await saveState(session, state, "canceled");
  await persistSessionSet(session, {
    status: "canceled",
    endedAt: new Date(),
  });
  return {
    reply:
      "Understood. I canceled the callback request. I retained the partial call record for quality and safety review, but the team will not treat it as a submitted callback request.",
    handoff: endPacket("callback-canceled", state.reason),
    callbackCaptured: false,
    callbackCanceled: true,
  };
};

const applyCurrentField = (state, customerMessage) => {
  const field = state.currentField;
  if (!field) return { captured: false };
  if (isSkipIntent(customerMessage) || /^(?:that(?:'s| is) all|nothing else)$/i.test(clean(customerMessage, 100))) {
    if (field === "phone") return { captured: false, invalid: true };
    markSkipped(state, field);
    return { captured: true };
  }

  const details = extractCallbackDetails(customerMessage, { currentField: field, knownService: state.serviceNeeded });
  applyExtractedDetails(state, details, { forceField: field });
  if (field === 'name' && !validFieldValue(state, 'name') && isPlausibleCallbackName(customerMessage)) {
    setStateValue(state, field, customerMessage);
  } else if (field === 'phone' && !state.phone) {
    setStateValue(state, field, customerMessage);
  }
  return validFieldValue(state, field)
    ? { captured: true }
    : { captured: false, invalid: true };
};

const correctionFromDeclaration = (value) => {
  const text = clean(value, 600);
  const match = text.match(
    /^(?:(?:my|the)\s+)?(name|address|location|zip|phone|number|service|problem|urgency|time|day|preference)\s+(?:is|should be|was)\s+(.+)$/i,
  );
  if (!match) return null;
  const aliases = {
    address: "location",
    zip: "location",
    number: "phone",
    problem: "service",
    time: "preference",
    day: "preference",
  };
  const rawField = match[1].toLowerCase();
  return { field: aliases[rawField] || rawField, value: clean(match[2], 500) };
};

const applyCorrection = (state, correction) => {
  if (!correction?.field || !ALL_FIELDS.includes(correction.field)) return false;
  const candidate = { ...state };
  setStateValue(candidate, correction.field, correction.value);
  if (!validFieldValue(candidate, correction.field)) return false;
  Object.assign(state, candidate);
  return true;
};

const handleQuestionDetour = async ({ session, state, customerMessage }) => {
  let answer = "";
  if (isBusinessHoursQuestion(customerMessage)) {
    answer = await VoiceAvailabilityService.describeBusinessHours(session.business);
  } else if (isServiceAreaQuestion(customerMessage)) {
    const postalCode = extractCallbackDetails(customerMessage).location;
    if (/^\d{5}$/.test(postalCode || "")) {
      const area = await validateServiceAreaTool({
        businessId: normalizeId(session.business),
        postalCode,
      });
      answer = area?.supported
        ? `${postalCode} is inside the approved service area.`
        : `${postalCode} is outside the approved automated service area, so the team will review it manually.`;
    } else {
      answer = "I can check the service area after you provide a five-digit ZIP code.";
    }
  }
  if (!answer) return null;

  const resumePrompt =
    state.status === "awaiting_confirmation"
      ? buildReadback(state)
      : state.currentField
        ? promptFor(state, state.currentField)
        : "Let’s continue the callback request.";
  state.lastPrompt = resumePrompt;
  await saveState(session, state);
  return {
    reply: `${answer} Returning to the callback request: ${resumePrompt}`,
    callbackCaptured: false,
  };
};

export { buildReadback, complete, cancelCapture, applyCurrentField, correctionFromDeclaration, applyCorrection, handleQuestionDetour };
