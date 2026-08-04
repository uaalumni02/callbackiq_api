import OpenAI from "openai";
import {
  detectSafetyHazardType,
  getEmergencyReply,
} from "../helpers/ai/aiGuardrails.js";
import {
  cleanVoiceText,
  extractPostalCode,
  isBookingIntent,
  isBusinessHoursQuestion,
  isCallbackRequest,
  isHumanRequest,
  isLikelyNonEnglish,
  isServiceAreaQuestion,
} from "./voiceInput.service.js";

const INTENTS = Object.freeze([
  "emergency",
  "human",
  "callback",
  "booking",
  "existing_job",
  "hours",
  "service_area",
  "pricing",
  "complaint",
  "service_request",
  "wrong_number",
  "opt_out",
  "general_help",
]);

const DIRECTED_ABUSE =
  /\b(?:you|your|y'all|yall|the company|this business|your business|your people)\b.{0,40}\b(?:fuck|shit|bitch|asshole|idiot|stupid|moron|scam|crook)\b|\b(?:fuck you|you suck|your company sucks)\b/i;
const SITUATION_PROFANITY = /\b(?:damn|fucking|fuckin|shit|crap)\b/i;
const SPANISH =
  /\b(?:hola|necesito|ayuda|por favor|hablo|español|espanol|plomero|fontanero|fuga|agua|calefacción|calefaccion|reparación|reparacion|servicio|cita)\b/i;
const EXISTING =
  /\b(?:where(?:'s| is) (?:my )?(?:tech|technician)|technician (?:en route|coming|late)|existing (?:job|appointment)|appointment today|previous repair|already came out)\b/i;
const WRONG =
  /\b(?:wrong number|didn'?t mean to call|not who i was calling)\b/i;
const OPT_OUT =
  /\b(?:do not call|don'?t call|stop texting|stop calling|delete my data|remove my number)\b/i;
const PRICING =
  /\b(?:price|cost|quote|estimate|diagnostic fee|service call fee)\b/i;
const COMPLAINT =
  /\b(?:complaint|refund|manager|ripped off|terrible service|dispute|chargeback)\b/i;

let client;
const getClient = () => {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout:
        Number(process.env.OPENAI_VOICE_CLASSIFIER_TIMEOUT_MS) || 2200,
      maxRetries: 0,
    });
  }
  return client;
};

const clean = (value, max = 500) => cleanVoiceText(value, max);

const deterministic = (text) => {
  const hazard = detectSafetyHazardType(text);
  const isEmergency = Boolean(hazard);
  const language = SPANISH.test(text) || isLikelyNonEnglish(text) ? "es" : "en";
  let intent = "general_help";
  if (isEmergency) intent = "emergency";
  else if (isHumanRequest(text)) intent = "human";
  else if (isCallbackRequest(text)) intent = "callback";
  else if (OPT_OUT.test(text)) intent = "opt_out";
  else if (WRONG.test(text)) intent = "wrong_number";
  else if (EXISTING.test(text)) intent = "existing_job";
  else if (COMPLAINT.test(text)) intent = "complaint";
  else if (isBusinessHoursQuestion(text)) intent = "hours";
  else if (isServiceAreaQuestion(text)) intent = "service_area";
  else if (PRICING.test(text)) intent = "pricing";
  else if (isBookingIntent(text)) intent = "booking";
  else if (text.length >= 8) intent = "service_request";

  const directedAbuse = DIRECTED_ABUSE.test(text);
  return {
    source: "deterministic",
    language,
    intent,
    confidence: isEmergency ? 100 : 65,
    safety: {
      isEmergency,
      shouldSendSafetyReply: isEmergency,
      hazardType: hazard || "none",
      hazardTypes: hazard ? [hazard] : [],
      reply: isEmergency ? getEmergencyReply(hazard || "other") : "",
    },
    directedAbuse,
    situationProfanity: SITUATION_PROFANITY.test(text) && !directedAbuse,
    entities: {
      service:
        intent === "service_request" || intent === "booking"
          ? clean(text, 240)
          : "",
      name: "",
      location: "",
      city: "",
      postalCode: extractPostalCode(text),
      urgency: /\b(?:emergency|urgent|today|asap|right away)\b/i.test(text)
        ? "high"
        : "",
      preference: "",
    },
  };
};

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    language: { type: "string", enum: ["en", "es", "other"] },
    intent: { type: "string", enum: INTENTS },
    confidence: { type: "number", minimum: 0, maximum: 100 },
    directedAbuse: { type: "boolean" },
    situationProfanity: { type: "boolean" },
    safety: {
      type: "object",
      additionalProperties: false,
      properties: {
        isEmergency: { type: "boolean" },
        shouldSendSafetyReply: { type: "boolean" },
        hazardType: { type: "string" },
        hazardTypes: { type: "array", items: { type: "string" } },
        reply: { type: "string" },
      },
      required: [
        "isEmergency",
        "shouldSendSafetyReply",
        "hazardType",
        "hazardTypes",
        "reply",
      ],
    },
    entities: {
      type: "object",
      additionalProperties: false,
      properties: {
        service: { type: "string" },
        name: { type: "string" },
        location: { type: "string" },
        city: { type: "string" },
        postalCode: { type: "string" },
        urgency: { type: "string" },
        preference: { type: "string" },
      },
      required: [
        "service",
        "name",
        "location",
        "city",
        "postalCode",
        "urgency",
        "preference",
      ],
    },
  },
  required: [
    "language",
    "intent",
    "confidence",
    "directedAbuse",
    "situationProfanity",
    "safety",
    "entities",
  ],
};

export const classifyVoiceTurn = async ({
  customerMessage,
  recentMessages = [],
}) => {
  const text = clean(customerMessage, 4000);
  const fallback = deterministic(text);

  // Deterministic safety is the hard fast-path. It never waits for a model.
  if (fallback.safety.isEmergency) return fallback;

  const openai = getClient();
  if (!openai) return fallback;

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_VOICE_CLASSIFIER_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "Classify one home-service phone turn. Distinguish profanity about a broken situation from abuse aimed at the assistant or business. Extract every usable callback field. Never invent data. Safety must be conservative.",
        },
        {
          role: "user",
          content: `Recent context:\n${recentMessages
            .slice(-6)
            .map(
              (message) =>
                `${message.direction || message.role}: ${clean(
                  message.body || message.text,
                  400,
                )}`,
            )
            .join("\n")}\nCaller: ${text}`,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "voice_turn",
          strict: true,
          schema,
        },
      },
      temperature: 0,
    });
    const parsed = JSON.parse(response.output_text || "{}");
    return {
      ...fallback,
      ...parsed,
      safety: { ...fallback.safety, ...(parsed.safety || {}) },
      entities: { ...fallback.entities, ...(parsed.entities || {}) },
      source: "openai",
      usage: response.usage || null,
    };
  } catch {
    return fallback;
  }
};

export const spanishHandoffReply = ({
  businessName = "el negocio",
  smsWillBeAttempted = true,
} = {}) =>
  `Gracias por llamar a ${businessName}. Soy el asistente automatizado. Guardé su solicitud para que el equipo le devuelva la llamada${
    smsWillBeAttempted
      ? " y también intentaré enviarle un mensaje de texto bilingüe"
      : ""
  }.`;

export default { classifyVoiceTurn, spanishHandoffReply };
