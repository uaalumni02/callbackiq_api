import { extractCustomerAddress, resolveRequestAddress } from '../services/booking/customerAddress.service.js';
import { ownerTextSuppressionReason } from "../services/messaging/ownerTextPolicy.service.js";
import { staffReviewDueAt } from "../services/staffReviewPolicy.service.js";
import mongoose from "mongoose";

import Alert from "../models/alert.js";
import Message from "../models/message.js";
import VoiceSession from "../models/voiceSession.js";
import {
  logOperationalError,
  logOperationalWarning,
} from "../helpers/logging/safeLogger.js";
import validateServiceAreaTool from "../helpers/ai/tools/validateServiceArea.tool.js";
import SocketService from "../services/socket.service.js";
import { sendSms } from "../services/twilioSmsService.js";
import { sanitizeUnverifiedStaffCommitments } from "../services/customerCommitmentSafety.service.js";
import VoiceAvailabilityService from "./voiceAvailability.service.js";
import {
  cleanVoiceText,
  extractCallbackDetails,
  extractPhoneNumber,
  isBusinessHoursQuestion,
  isCancelIntent,
  isNo,
  isPlausibleCallbackName,
  isRepeatIntent,
  isServiceAreaQuestion,
  isSkipIntent,
  isYes,
  normalizeUrgency,
  parseCorrection,
  toSpokenReply,
} from "./voiceInput.service.js";
import VoiceLineTypeService from "./voiceLineType.service.js";
import VoiceMetricsService from "./voiceMetrics.service.js";
import {
  isUsableCallerId,
  normalizePhoneToE164,
  speakDigits,
} from "./voicePhone.service.js";

import { assertVoiceTurnActive } from "../services/voiceTurnContext.service.js";
const DEFAULT_REQUIRED_FIELDS = Object.freeze([
  "service",
  "name",
  "location",
  "preference",
]);
const ALL_FIELDS = Object.freeze([...DEFAULT_REQUIRED_FIELDS, "phone"]);
const ACTIVE_STATUSES = new Set([
  "started",
  "collecting_service",
  "collecting_name",
  "collecting_location",
  "collecting_urgency",
  "collecting_preference",
  "collecting_phone",
  "awaiting_confirmation",
  "awaiting_correction",
]);
const PLACEHOLDER_SERVICE = /^(?:unknown|voice inquiry|service request)$/i;
const PLACEHOLDER_NAME = /^(?:voice caller|anonymous voice caller|customer|caller)$/i;
const FIELD_LABELS = Object.freeze({
  service: "service or problem",
  name: "name",
  location: "service location",
  urgency: "urgency",
  preference: "preferred day or time",
  phone: "callback number",
});
const PROMPTS = Object.freeze({
  service:
    "What service or problem should the team help you with? You can describe it in a few words.",
  name: "What name should I put on the callback request?",
  location:
    "What is the service address or five-digit ZIP code? You can say skip if you prefer to provide it later.",
  urgency:
    "How urgent is this: today, soon, or flexible? Do not wait for a callback if anyone is in immediate danger.",
  preference:
    "What day or time would you prefer the team to contact you or schedule the visit?",
  phone:
    "Your caller ID is blocked or unavailable. Please say the ten-digit phone number the team should call back.",
});
const SPANISH_PROMPTS = Object.freeze({
  service: "¿En qué servicio o problema necesita ayuda? Puede decirlo en pocas palabras.",
  name: "¿Qué nombre debo poner en la solicitud?",
  location: "¿Cuál es la dirección o el código postal? Puede decir omitir.",
  urgency: "¿Qué tan urgente es: hoy, pronto o flexible?",
  preference: "¿Qué día u hora prefiere para la llamada o visita?",
  phone: "No aparece su número. Diga los diez dígitos, uno por uno.",
});
const promptFor = (state, field) =>
  (state?.language === "es" ? SPANISH_PROMPTS : PROMPTS)[field] || PROMPTS.service;

const normalizeId = (value) => value?._id || value?.id || value || null;
const clean = (value, maximum = 1000) => cleanVoiceText(value, maximum);
const recordCallbackMetric = (session, event, metadata = {}) => {
  if (!session?._id) return;
  void VoiceMetricsService.recordVoiceMetric({ sessionId: session._id, event, metadata });
};
const appendText = (existing, value, maximum) =>
  [clean(existing, maximum), clean(value, maximum)]
    .filter(Boolean)
    .join("\n")
    .slice(0, maximum);
const latestCustomerMessage = (session) =>
  session?.transcript
    ?.filter((entry) => entry.role === "customer")
    .at(-1)?.text || "";
const endPacket = (reasonCode, reason) => ({
  type: "end",
  handoffData: JSON.stringify({
    reasonCode,
    reason,
    callbackCaptured: reasonCode === "callback-captured",
  }),
});
const dueAtForPriority = staffReviewDueAt;
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

const normalizeName = (value) =>
  clean(value, 120)
    .replace(/^(?:my name is|this is|i am|i'm)\s+/i, "")
    .trim();
const skippedValue = (value) => /^(?:not provided|skipped)$/i.test(clean(value, 100));
const callerPhone = (session) =>
  normalizePhoneToE164(
    session?.metadata?.callbackCapture?.phone || session?.from || session?.lead?.phone,
  );

// Recover evidence from this call only when the durable request has no
// location. Final caller turns are authoritative; assistant guesses are not.
const recoverCallAddress = session => {
  const saved = resolveRequestAddress({ lead: session.lead, conversation: session.conversation });
  if (saved) return saved;
  const turns = (session.transcript || []).filter(turn => turn.role === 'customer' && turn.isFinal !== false);
  for (const turn of [...turns].reverse()) {
    const address = extractCustomerAddress(turn.text);
    if (address) return address;
  }
  return '';
};

const createState = ({
  session,
  reason,
  alertType,
  priority,
  requiredFields,
  seed,
  customerMessage,
  seedServiceFromMessage,
}) => {
  const lead = session?.lead;
  const existingService = clean(lead?.serviceNeeded, 200);
  const existingName = clean(lead?.customerName, 120);
  const phone = normalizePhoneToE164(seed?.phone || session?.from || lead?.phone);
  const callerIdUsable = Boolean(
    session?.metadata?.callerIdUsable ?? isUsableCallerId(session?.from),
  );
  const requestedFields = Array.isArray(requiredFields)
    ? requiredFields.filter((field) => ALL_FIELDS.includes(field))
    : [...DEFAULT_REQUIRED_FIELDS];
  if (!callerIdUsable && !requestedFields.includes("phone")) {
    requestedFields.push("phone");
  }
  const state = {
    status: "started",
    currentField: "",
    reason: clean(reason || "callback_requested", 200),
    alertType: clean(alertType || "human_requested", 80),
    priority: ["low", "medium", "high", "critical"].includes(priority)
      ? priority
      : "high",
    language: seed?.language === "es" ? "es" : "en",
    requiredFields: requestedFields,
    serviceNeeded:
      clean(seed?.serviceNeeded, 200) ||
      (!PLACEHOLDER_SERVICE.test(existingService) ? existingService : ""),
    customerName:
      clean(seed?.customerName, 120) ||
      (!PLACEHOLDER_NAME.test(existingName) ? existingName : ""),
    location: clean(seed?.location || recoverCallAddress(session) || lead?.address, 500),
    urgency: clean(seed?.urgency, 40),
    urgencyDetail: clean(seed?.urgencyDetail, 200),
    preferredTime: clean(
      seed?.preferredTime || lead?.preferredAppointmentTime,
      500,
    ),
    phone: callerIdUsable ? phone : clean(seed?.phone, 30),
    callerIdUsable,
    retryCounts: {},
    skippedFields: [],
    lastPrompt: "",
    requestedAt: new Date().toISOString(),
    completedAt: null,
    canceledAt: null,
    confirmationSmsStatus: "pending",
    confirmationSmsProviderMessageId: "",
  };
  if (!state.serviceNeeded && seedServiceFromMessage) {
    if (extractCallbackDetails(customerMessage).service) state.serviceNeeded = clean(customerMessage, 200);
  }
  return state;
};

const stateValue = (state, field) => {
  if (field === "service") return state.serviceNeeded;
  if (field === "name") return state.customerName;
  if (field === "location") return state.location;
  if (field === "urgency") return state.urgency;
  if (field === "preference") return state.preferredTime;
  if (field === "phone") return state.phone;
  return "";
};
const setStateValue = (state, field, value) => {
  const normalized = clean(value, 500);
  if (field === "service") state.serviceNeeded = normalized.slice(0, 200);
  if (field === "name") state.customerName = normalizeName(normalized).slice(0, 120);
  if (field === 'location') {
    state.location = /^\d{5}$/.test(normalized) && state.location && !/^\d{5}$/.test(state.location) && !skippedValue(state.location)
      ? (state.location.replace(/\b\d{5}(?:-\d{4})?$/, '').trim() + ' ' + normalized).slice(0, 500)
      : normalized.slice(0, 500);
  }
  if (field === "urgency") {
    state.urgency = normalizeUrgency(normalized);
    state.urgencyDetail = normalized.slice(0, 200);
  }
  if (field === 'preference') {
    const day = state.preferredTime?.match(/\b(?:(?:next|this) )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)\b/i)?.[0];
    state.preferredTime = day && /^(?:at )?\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?[.!]*$/i.test(normalized)
      ? `${day} at ${normalized.replace(/^at /i, '')}` : normalized.slice(0, 500);
  }
  if (field === "phone") state.phone = extractPhoneNumber(normalized);
};
const nextMissingField = (state) =>
  state.requiredFields.find((field) => !validFieldValue(state, field)) || null;

const applyExtractedDetails = (state, details, { forceField = "" } = {}) => {
  const mapping = {
    service: "serviceNeeded",
    name: "customerName",
    location: "location",
    urgency: "urgency",
    urgencyDetail: "urgencyDetail",
    preference: "preferredTime",
    phone: "phone",
  };
  for (const [source, target] of Object.entries(mapping)) {
    const value = details?.[source];
    if (!value) continue;
    if (forceField && source !== forceField) continue;
    if (!forceField && state[target] && !['service', 'location', 'preference', 'name'].includes(source)) continue;
    if (source === 'location' || source === 'preference') { setStateValue(state, source, value); continue; }
    if (source === "name") state[target] = normalizeName(value).slice(0, 120);
    else if (source === "phone") state[target] = normalizePhoneToE164(value);
    else state[target] = clean(value, target === "serviceNeeded" ? 200 : 500);
  }
};

const validFieldValue = (state, field) => {
  const value = stateValue(state, field);
  if (!value) return false;
  if (skippedValue(value)) return field !== "phone";
  if (field === "phone") return isUsableCallerId(value);
  if (field === "name") return isPlausibleCallbackName(value);
  if (field === 'location') return Boolean(extractCallbackDetails(value, { currentField: 'location' }).location);
  if (field === "service") return value.length >= 3;
  if (field === 'preference') return Boolean(extractCallbackDetails(value, { currentField: 'preference' }).preference);
  return true;
};

const markSkipped = (state, field) => {
  if (!state.skippedFields.includes(field)) state.skippedFields.push(field);
  setStateValue(state, field, "Not provided");
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

const createCallbackAlert = async ({ session, state, canceled = false }) => {
  assertVoiceTurnActive();
  const businessId = normalizeId(session.business);
  const leadId = normalizeId(session.lead);
  const conversationId = normalizeId(session.conversation);
  const suffix = canceled ? "canceled" : state.reason;
  const dedupeKey = `voice_callback:${normalizeId(session)}:${suffix}`.slice(0, 200);
  const priority = canceled ? "low" : state.priority;
  const alert = await Alert.findOneAndUpdate(
    { business: businessId, dedupeKey },
    {
      $setOnInsert: {
        business: businessId,
        lead: leadId,
        conversation: conversationId,
        type: state.alertType,
        channel: "in_app",
        title: canceled
          ? "Voice callback capture canceled"
          : priority === "critical"
            ? "Urgent voice safety escalation"
            : "Customer callback requested",
        message: canceled
          ? "The caller canceled before submitting the callback request. Partial details were retained for review."
          : priority === "critical"
            ? "A caller reported a potential emergency or safety risk. Review immediately, but the caller was told not to wait for a callback or use CallBackIQ instead of emergency services."
            : `CallBackIQ captured a callback request for ${state.serviceNeeded || "a customer inquiry"}.`,
        status: "pending",
        priority,
        actionRequired: !canceled,
        dueAt: canceled ? null : dueAtForPriority(priority),
        reason: canceled ? "caller_canceled_callback_capture" : state.reason,
        recommendedAction: canceled
          ? "Review only if the partial transcript indicates follow-up is appropriate."
          : priority === "critical"
            ? "Review the transcript immediately. Emergency services remain the caller's first action."
            : state.phone && isUsableCallerId(state.phone)
              ? "Review the captured details and contact the caller at the confirmed number."
              : "Review the captured details. No usable callback number was confirmed.",
        aiSummary: clean(
          `Service: ${state.serviceNeeded || "Not provided"}; name: ${state.customerName || "Not provided"}; location: ${state.location || "Not provided"}; urgency: ${state.urgencyDetail || state.urgency || "Not provided"}; preferred time: ${state.preferredTime || "Not provided"}; callback number: ${state.phone && isUsableCallerId(state.phone) ? "confirmed" : "not available"}.`,
          2000,
        ),
        lastCustomerMessage: clean(latestCustomerMessage(session), 1600),
        dedupeKey,
        metadata: {
          source: "voice_callback_capture",
          voiceSessionId: normalizeId(session),
          providerCallSid: session.providerCallSid || "",
          callbackCanceled: canceled,
          callbackDetails: {
            serviceNeeded: state.serviceNeeded,
            customerName: state.customerName,
            location: state.location,
            urgency: state.urgency,
            urgencyDetail: state.urgencyDetail,
            preferredTime: state.preferredTime,
            callbackPhoneConfirmed: Boolean(
              state.phone && isUsableCallerId(state.phone),
            ),
          },
        },
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  if (!alert?._id) throw Object.assign(new Error("Callback alert was not persisted."), { code: "STAFF_ACTION_NOT_SAVED" });
  emit("emitAlertCreated", businessId, alert);
  return alert;
};

const callbackConfirmationBody = ({ business, state }) => {
  const businessName = clean(business?.businessName, 120) || "the business";
  const service =
    state.serviceNeeded && !skippedValue(state.serviceNeeded)
      ? ` about ${state.serviceNeeded}`
      : "";
  const preference =
    state.preferredTime && !skippedValue(state.preferredTime)
      ? ` Your preferred timing is ${state.preferredTime}.`
      : "";
  const english = `Hi${state.customerName && !skippedValue(state.customerName) ? ` ${state.customerName}` : ""}, this is ${businessName}. CallBackIQ received your callback request${service}.${preference} The request has been flagged for the team. A callback time is not guaranteed. Reply STOP to opt out.`;
  const spanish = `Hola. ${businessName} recibió su solicitud de devolución de llamada. La solicitud fue enviada al equipo. No se garantiza una hora de devolución de llamada. Responda STOP para no recibir mensajes.`;
  return clean(state.language === "es" ? `${spanish} / ${english}` : english, 1600);
};

const persistConfirmationState = async (session, state) => {
  const confirmationSet = {
    confirmationSmsStatus: state.confirmationSmsStatus,
    confirmationSmsProviderMessageId:
      state.confirmationSmsProviderMessageId || "",
    ...(state.confirmationSmsStatus === "sent"
      ? { confirmationSmsSentAt: new Date() }
      : {}),
    "metadata.callbackCapture": state,
    lastActivityAt: new Date(),
  };
  await persistSessionSet(session, confirmationSet);
  session.confirmationSmsStatus = state.confirmationSmsStatus;
  session.confirmationSmsProviderMessageId =
    state.confirmationSmsProviderMessageId || "";
};

const sendCallbackConfirmation = async ({ session, state }) => {
  const business = session.business;
  const lead = session.lead;
  const conversation = session.conversation;
  const from = normalizePhoneToE164(session.to || business?.phone);
  const to = normalizePhoneToE164(state.phone || session.from || lead?.phone);

  if (["sent", "sending", "suppressed"].includes(session.confirmationSmsStatus)) {
    state.confirmationSmsStatus = session.confirmationSmsStatus;
    state.confirmationSmsProviderMessageId =
      session.confirmationSmsProviderMessageId || "";
    return;
  }
  if (
    Boolean(ownerTextSuppressionReason({ business, source: "voice_callback_capture" })) ||
    !from ||
    !isUsableCallerId(to)
  ) {
    state.confirmationSmsStatus = "suppressed";
    await persistConfirmationState(session, state);
    return;
  }

  const line = await VoiceLineTypeService.lookup(to);
  state.lineType = line.lineType;
  state.lineTypeSource = line.source;
  if (line.landline) {
    state.confirmationSmsStatus = "suppressed";
    state.confirmationSmsSuppressionReason = `line_type:${line.lineType}`;
    await persistConfirmationState(session, state);
    return;
  }

  const body = callbackConfirmationBody({ business, state });
  state.confirmationSmsStatus = "sending";
  await persistConfirmationState(session, state);
  try {
    assertVoiceTurnActive();
    const sent = await sendSms({
      business,
      businessId: normalizeId(business),
      from,
      to,
      body,
      actorType: "voice",
      source: "voice_callback_capture",
      usageCategory: "voice_callback_confirmation",
      conversationId: normalizeId(conversation),
      leadId: normalizeId(lead),
      metadata: {
        voiceSessionId: normalizeId(session),
        callbackReason: state.reason,
      },
    });
    if (sent?.suppressed) {
      state.confirmationSmsStatus = "suppressed";
      state.confirmationSmsSuppressionReason = sent.reason || "sms_policy";
      await persistConfirmationState(session, state);
      return;
    }

    const providerMessageId = sent?.sid || "";
    state.confirmationSmsStatus = "sent";
    state.confirmationSmsProviderMessageId = providerMessageId;
    await persistConfirmationState(session, state);

    if (conversation) {
      try {
        const message = await Message.create({
          business: normalizeId(business),
          conversation: normalizeId(conversation),
          lead: normalizeId(lead),
          direction: "outbound",
          from,
          to,
          body,
          provider: "twilio",
          providerMessageId,
          status: sent?.status || "sent",
          isAiGenerated: false,
          generatedBy: "voice",
          usageCategory: "voice_callback_confirmation",
          actorType: "voice",
          metadata: {
            source: "voice_callback_capture",
            voiceSessionId: normalizeId(session),
            callbackReason: state.reason,
          },
        });
        emit("emitMessageCreated", normalizeId(business), message);
        conversation.lastMessage = body;
        conversation.lastMessageAt = new Date();
        await conversation.save();
        emit("emitConversationUpdated", normalizeId(business), conversation);
      } catch (error) {
        logOperationalError(
          "voice.callback_confirmation_local_persistence_failed",
          error,
          {
            businessId: normalizeId(business),
            voiceSessionId: normalizeId(session),
            providerMessageId,
          },
        );
      }
    }
  } catch (error) {
    state.confirmationSmsStatus = "failed";
    await persistConfirmationState(session, state);
    logOperationalError("voice.callback_confirmation_sms_failed", error, {
      businessId: normalizeId(business),
      voiceSessionId: normalizeId(session),
      errorCode: error?.code || error?.name || "error",
    });
  }
};

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

class VoiceCallbackService {
  static isActive(session) {
    return ACTIVE_STATUSES.has(session?.metadata?.callbackCapture?.status || "");
  }

  static async handle({
    session,
    customerMessage = "",
    reason = "callback_requested",
    alertType = "human_requested",
    priority = "high",
    requiredFields = DEFAULT_REQUIRED_FIELDS,
    seed = {},
    seedServiceFromMessage = false,
    openingPrompt = "",
    immediate = false,
    completionReply = "",
    sendConfirmationSms = true,
  }) {
    assertVoiceTurnActive();
    if (!session?.business || !session?.lead || !session?.conversation) {
      throw new Error(
        "Voice callback capture requires business, lead, and conversation context.",
      );
    }

    const text = clean(customerMessage, 1200);
    const active = this.isActive(session);
    const state = active
      ? {
          ...session.metadata.callbackCapture,
          retryCounts: { ...(session.metadata.callbackCapture.retryCounts || {}) },
          skippedFields: [...(session.metadata.callbackCapture.skippedFields || [])],
        }
      : createState({
          session,
          reason,
          alertType,
          priority,
          requiredFields,
          seed,
          customerMessage: text,
          seedServiceFromMessage,
        });

    const factsChanged = active && reconcileLead(session, state);
    if (!state.location) state.location = recoverCallAddress(session);
    if (factsChanged && !immediate && state.status === 'awaiting_confirmation') {
      const missing = nextMissingField(state);
      state.currentField = missing || '';
      state.status = missing ? `collecting_${missing}` : 'awaiting_confirmation';
      state.lastPrompt = missing ? promptFor(state, missing) : buildReadback(state);
      await saveState(session, state);
      return { reply: `The request details changed. ${state.lastPrompt}`, callbackCaptured: false };
    }

    if (immediate) {
      if (active && alertType === 'safety_emergency') {
        Object.assign(state, { reason, alertType, priority: 'critical', urgency: 'emergency',
          urgencyDetail: clean(seed.urgencyDetail || text, 200) });
      }
      return complete({
        session,
        state,
        reply: completionReply,
        sendConfirmationSms,
      });
    }
    if (isCancelIntent(text)) return cancelCapture({ session, state });
    if (isRepeatIntent(text)) {
      const prompt = state.lastPrompt || promptFor(state, state.currentField) || buildReadback(state);
      return { reply: `Of course. ${prompt}`, callbackCaptured: false };
    }

    const detour = await handleQuestionDetour({
      session,
      state,
      customerMessage: text,
    });
    if (detour) return detour;

    const declaredCorrection = parseCorrection(text) || correctionFromDeclaration(text);
    if (declaredCorrection?.field && !['awaiting_confirmation', 'awaiting_correction'].includes(state.status)) {
      applyCorrection(state, declaredCorrection);
    }
    if (state.status === "awaiting_confirmation") {
      if (isYes(text)) {
        return complete({
          session,
          state,
          reply: completionReply,
          sendConfirmationSms,
        });
      }
      const parsed = parseCorrection(text) || correctionFromDeclaration(text);
      const details = extractCallbackDetails(text, { knownService: state.serviceNeeded });
      const suppliedField = ['service', 'location', 'preference', 'name', 'phone'].filter(field => details[field]);
      const correction = parsed?.field ? parsed : suppliedField.length === 1 ? { field: suppliedField[0], value: details[suppliedField[0]] } : null;
      if (correction && applyCorrection(state, correction)) {
        state.status = "awaiting_confirmation";
        state.currentField = "";
        state.lastPrompt = buildReadback(state);
        await saveState(session, state);
        return { reply: state.lastPrompt, callbackCaptured: false };
      }
      if (isNo(text)) {
        state.status = "awaiting_correction";
        state.lastPrompt =
          "Which detail should I change: the service, name, location, urgency, preferred time, or callback number?";
        await saveState(session, state);
        return { reply: state.lastPrompt, callbackCaptured: false };
      }
      state.retryCounts.confirmation = (state.retryCounts.confirmation || 0) + 1;
      if (state.retryCounts.confirmation >= 3) {
        state.status = "awaiting_correction";
        state.lastPrompt =
          "I did not hear a clear confirmation. Tell me one detail to change, or say yes if everything is correct.";
      } else {
        state.lastPrompt =
          "Please say yes if the details are correct, or tell me which detail to change.";
      }
      await saveState(session, state);
      return { reply: state.lastPrompt, callbackCaptured: false };
    }

    if (state.status === "awaiting_correction") {
      const parsed = parseCorrection(text) || correctionFromDeclaration(text);
      const details = extractCallbackDetails(text, { knownService: state.serviceNeeded });
      const suppliedField = ['service', 'location', 'preference', 'name', 'phone'].filter(field => details[field]);
      const correction = parsed?.field ? parsed : suppliedField.length === 1 ? { field: suppliedField[0], value: details[suppliedField[0]] } : null;
      if (!correction || !applyCorrection(state, correction)) {
        state.retryCounts.correction = (state.retryCounts.correction || 0) + 1;
        state.lastPrompt =
          "Please say the detail and its correction, for example, ‘my ZIP is three zero three zero three.’";
        await saveState(session, state);
        return { reply: state.lastPrompt, callbackCaptured: false };
      }
      state.status = "awaiting_confirmation";
      state.currentField = "";
      state.lastPrompt = buildReadback(state);
      await saveState(session, state);
      return { reply: state.lastPrompt, callbackCaptured: false };
    }

    if (active && state.currentField && text) {
      // Capture every usable field in a compound utterance before applying the
      // current-field fallback. This shortens callback capture without re-asks.
      applyExtractedDetails(
        state,
        extractCallbackDetails(text, { currentField: state.currentField, knownService: state.serviceNeeded }),
      );
      const supplied = extractCallbackDetails(text, { knownService: state.serviceNeeded });
      const otherFact = Object.keys(supplied).some(key => key !== state.currentField && key !== 'urgencyDetail');
      const result = validFieldValue(state, state.currentField)
        ? { captured: true }
        : applyCurrentField(state, text);
      if (result.invalid) {
        const field = state.currentField;
        state.retryCounts[field] = (state.retryCounts[field] || 0) + (otherFact ? 0 : 1);
        if (state.retryCounts[field] >= 2) {
          if (field === "phone") {
            state.phone = "Not provided";
            state.skippedFields.push("phone");
          } else {
            markSkipped(state, field);
          }
        } else {
          state.lastPrompt =
            field === "phone"
              ? "I could not confirm that phone number. Please say all ten digits, one digit at a time."
              : `I did not catch the ${FIELD_LABELS[field]}. ${promptFor(state, field)}`;
          recordCallbackMetric(session, "field_reasked", { field });
          await saveState(session, state);
          return { reply: state.lastPrompt, callbackCaptured: false };
        }
      }
    } else if (!active && text) {
      applyExtractedDetails(
        state,
        ({ ...extractCallbackDetails(text, { currentField: "service", knownService: state.serviceNeeded }), ...(state.serviceNeeded ? { service: null } : {}) }),
      );
    }

    const missing = nextMissingField(state);
    if (missing) {
      state.currentField = missing;
      state.status = `collecting_${missing}`;
      state.lastPrompt = [clean(openingPrompt, 800), promptFor(state, missing)]
        .filter(Boolean)
        .join(" ");
      recordCallbackMetric(session, "field_prompted", { field: missing });
      await saveState(session, state);
      return { reply: state.lastPrompt, callbackCaptured: false };
    }

    state.currentField = "";
    state.status = "awaiting_confirmation";
    state.lastPrompt = buildReadback(state);
    await saveState(session, state);
    return { reply: state.lastPrompt, callbackCaptured: false };
  }
}

export { DEFAULT_REQUIRED_FIELDS };
export default VoiceCallbackService;
