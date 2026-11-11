import "../../services/booking/customerAddress.service.js";
import "../../services/messaging/ownerTextPolicy.service.js";
import { staffReviewDueAt } from "../../services/staffReviewPolicy.service.js";
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
import { cleanVoiceText } from "../voiceInput.service.js";
import "../voiceLineType.service.js";
import VoiceMetricsService from "../voiceMetrics.service.js";
import "../voicePhone.service.js";
import "../../services/voiceTurnContext.service.js";


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

const normalizeName = (value) =>
  clean(value, 120)
    .replace(/^(?:my name is|this is|i am|i'm)\s+/i, "")
    .trim();

const skippedValue = (value) => /^(?:not provided|skipped)$/i.test(clean(value, 100));

export { DEFAULT_REQUIRED_FIELDS, ALL_FIELDS, ACTIVE_STATUSES, PLACEHOLDER_SERVICE, PLACEHOLDER_NAME, FIELD_LABELS, PROMPTS, SPANISH_PROMPTS, promptFor, normalizeId, clean, recordCallbackMetric, appendText, latestCustomerMessage, endPacket, dueAtForPriority, normalizeName, skippedValue };
