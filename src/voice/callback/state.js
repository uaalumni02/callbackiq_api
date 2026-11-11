import { extractCustomerAddress, resolveRequestAddress } from '../../services/booking/customerAddress.service.js';
import "../../services/messaging/ownerTextPolicy.service.js";
import "../../services/staffReviewPolicy.service.js";
import "mongoose";
import "../../models/alert.js";
import "../../models/message.js";
import "../../models/voiceSession.js";
import "../../helpers/logging/safeLogger.js";
import "../../helpers/ai/tools/validateServiceArea.tool.js";
import "../../services/socket.service.js";
import "../../services/twilioSmsService.js";
import "../../services/customerCommitmentSafety.service.js";
import "../voiceAvailability.service.js";
import { extractCallbackDetails, extractPhoneNumber, isPlausibleCallbackName, normalizeUrgency } from "../voiceInput.service.js";
import "../voiceLineType.service.js";
import "../voiceMetrics.service.js";
import { isUsableCallerId, normalizePhoneToE164 } from "../voicePhone.service.js";
import "../../services/voiceTurnContext.service.js";
import { clean, ALL_FIELDS, DEFAULT_REQUIRED_FIELDS, PLACEHOLDER_SERVICE, PLACEHOLDER_NAME, normalizeName, skippedValue } from './policy.js';

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

export { recoverCallAddress, createState, stateValue, setStateValue, nextMissingField, applyExtractedDetails, validFieldValue, markSkipped };
