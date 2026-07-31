import Alert from "../models/alert.js";
import Message from "../models/message.js";
import {
  logOperationalError,
  logOperationalWarning,
} from "../helpers/logging/safeLogger.js";
import SocketService from "../services/socket.service.js";
import { sendSms } from "../services/twilioSmsService.js";

const DEFAULT_REQUIRED_FIELDS = Object.freeze([
  "service",
  "name",
  "location",
  "urgency",
  "preference",
]);
const ACTIVE_STATUSES = new Set([
  "collecting_service",
  "collecting_name",
  "collecting_location",
  "collecting_urgency",
  "collecting_preference",
]);
const SKIP_PATTERN = /^(skip|unknown|not sure|i don't know|none|not provided)$/i;
const PLACEHOLDER_SERVICE = /^(unknown|voice inquiry|service request)$/i;
const PLACEHOLDER_NAME = /^(voice caller|customer|caller)$/i;

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
});

const normalizeId = (value) => value?._id || value?.id || value || null;
const clean = (value, max = 1000) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const appendText = (existing, value, max) =>
  [clean(existing, max), clean(value, max)]
    .filter(Boolean)
    .join("\n")
    .slice(0, max);

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

const dueAtForPriority = (priority) => {
  const minutes =
    priority === "critical" ? 5 : priority === "high" ? 30 : 120;
  return new Date(Date.now() + minutes * 60 * 1000);
};

const normalizeUrgency = (value) => {
  const text = clean(value, 200).toLowerCase();
  if (/\b(emergency|immediate|right now|danger|unsafe)\b/.test(text)) {
    return "emergency";
  }
  if (/\b(today|urgent|as soon as possible|asap|high)\b/.test(text)) {
    return "high";
  }
  if (/\b(flexible|whenever|not urgent|low)\b/.test(text)) {
    return "low";
  }
  return "medium";
};

const normalizeName = (value) =>
  clean(value, 120)
    .replace(/^(my name is|this is|i am|i'm)\s+/i, "")
    .trim();

const fallbackValue = (value) =>
  SKIP_PATTERN.test(clean(value, 100)) ? "Not provided" : clean(value, 500);

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
  const state = {
    status: "started",
    currentField: "",
    reason: clean(reason || "callback_requested", 200),
    alertType: clean(alertType || "human_requested", 80),
    priority: ["low", "medium", "high", "critical"].includes(priority)
      ? priority
      : "high",
    requiredFields: Array.isArray(requiredFields)
      ? requiredFields.filter((field) => DEFAULT_REQUIRED_FIELDS.includes(field))
      : [...DEFAULT_REQUIRED_FIELDS],
    serviceNeeded:
      clean(seed?.serviceNeeded, 200) ||
      (!PLACEHOLDER_SERVICE.test(existingService) ? existingService : ""),
    customerName:
      clean(seed?.customerName, 120) ||
      (!PLACEHOLDER_NAME.test(existingName) ? existingName : ""),
    location: clean(seed?.location || lead?.address, 500),
    urgency: clean(seed?.urgency, 40),
    urgencyDetail: clean(seed?.urgencyDetail, 200),
    preferredTime: clean(
      seed?.preferredTime || lead?.preferredAppointmentTime,
      500,
    ),
    requestedAt: new Date().toISOString(),
    completedAt: null,
    confirmationSmsStatus: "pending",
    confirmationSmsProviderMessageId: "",
  };

  if (!state.serviceNeeded && seedServiceFromMessage) {
    state.serviceNeeded = clean(customerMessage, 200);
  }

  return state;
};

const stateValue = (state, field) => {
  if (field === "service") return state.serviceNeeded;
  if (field === "name") return state.customerName;
  if (field === "location") return state.location;
  if (field === "urgency") return state.urgency;
  if (field === "preference") return state.preferredTime;
  return "";
};

const nextMissingField = (state) =>
  state.requiredFields.find((field) => !stateValue(state, field)) || null;

const captureField = (state, field, customerMessage) => {
  const value = clean(customerMessage, 500);
  if (!value) return state;

  if (field === "service") {
    state.serviceNeeded = fallbackValue(value).slice(0, 200);
  } else if (field === "name") {
    state.customerName = fallbackValue(normalizeName(value)).slice(0, 120);
  } else if (field === "location") {
    state.location = fallbackValue(value).slice(0, 500);
  } else if (field === "urgency") {
    state.urgency = normalizeUrgency(value);
    state.urgencyDetail = fallbackValue(value).slice(0, 200);
  } else if (field === "preference") {
    state.preferredTime = fallbackValue(value).slice(0, 500);
  }

  return state;
};

const saveState = async (session, state) => {
  session.metadata = {
    ...(session.metadata || {}),
    callbackCapture: state,
  };
  session.lastActivityAt = new Date();
  await session.save();
};

const updateLead = async ({ session, state }) => {
  const lead = session?.lead;
  if (!lead || typeof lead.save !== "function") return;

  if (state.customerName && state.customerName !== "Not provided") {
    lead.customerName = state.customerName;
  }
  if (state.serviceNeeded && state.serviceNeeded !== "Not provided") {
    lead.serviceNeeded = state.serviceNeeded;
  }
  if (state.location && state.location !== "Not provided") {
    lead.address = state.location;
  }
  if (state.preferredTime && state.preferredTime !== "Not provided") {
    lead.preferredAppointmentTime = state.preferredTime;
  }
  if (state.urgency) {
    lead.urgency = state.urgency;
  }
  lead.status = lead.status || "new";
  lead.firstRespondedAt = lead.firstRespondedAt || new Date();
  lead.summary = clean(
    `Voice callback requested. Service: ${state.serviceNeeded || "Not provided"}. Location: ${state.location || "Not provided"}. Urgency: ${state.urgencyDetail || state.urgency || "Not provided"}. Preferred time: ${state.preferredTime || "Not provided"}.`,
    1000,
  );
  lead.notes = appendText(
    lead.notes,
    `CallBackIQ voice callback capture (${state.reason}) completed at ${new Date().toISOString()}.`,
    2000,
  );
  await lead.save();
  emit("emitLeadUpdated", session.business?._id || session.business, lead);
};

const updateConversation = async ({ session, state }) => {
  const conversation = session?.conversation;
  if (!conversation || typeof conversation.save !== "function") return;

  conversation.customerName =
    state.customerName && state.customerName !== "Not provided"
      ? state.customerName
      : conversation.customerName;
  conversation.humanTakeover = true;
  conversation.aiEnabled = false;
  conversation.bookingState = {
    ...(conversation.bookingState?.toObject?.() || conversation.bookingState || {}),
    status: "human_takeover",
    lastError: `Callback requested: ${state.reason}`.slice(0, 500),
  };
  conversation.lastMessage = `Callback requested for ${state.serviceNeeded || "customer inquiry"}.`;
  conversation.lastMessageAt = new Date();
  await conversation.save();
  emit(
    "emitConversationUpdated",
    session.business?._id || session.business,
    conversation,
  );
};

const createCallbackAlert = async ({ session, state }) => {
  const businessId = normalizeId(session.business);
  const leadId = normalizeId(session.lead);
  const conversationId = normalizeId(session.conversation);
  const dedupeKey = `voice_callback:${normalizeId(session)}:${state.reason}`.slice(
    0,
    200,
  );
  const alert = await Alert.findOneAndUpdate(
    { business: businessId, dedupeKey },
    {
      $setOnInsert: {
        business: businessId,
        lead: leadId,
        conversation: conversationId,
        type: state.alertType,
        channel: "in_app",
        title:
          state.priority === "critical"
            ? "Urgent voice safety escalation"
            : "Customer callback requested",
        message:
          state.priority === "critical"
            ? "A caller reported a potential emergency or safety risk. Review immediately, but the caller was told not to wait for a callback or to use CallBackIQ instead of emergency services."
            : `CallBackIQ captured a callback request for ${state.serviceNeeded || "a customer inquiry"}.`,
        status: "pending",
        priority: state.priority,
        actionRequired: true,
        dueAt: dueAtForPriority(state.priority),
        reason: state.reason,
        recommendedAction:
          state.priority === "critical"
            ? "Review the transcript immediately. Contact the caller only when safe and appropriate; emergency services remain the caller's first action."
            : "Review the captured details and contact the caller at the number on the lead.",
        aiSummary: clean(
          `Service: ${state.serviceNeeded || "Not provided"}; name: ${state.customerName || "Not provided"}; location: ${state.location || "Not provided"}; urgency: ${state.urgencyDetail || state.urgency || "Not provided"}; preferred time: ${state.preferredTime || "Not provided"}.`,
          2000,
        ),
        lastCustomerMessage: clean(latestCustomerMessage(session), 1600),
        dedupeKey,
        metadata: {
          source: "voice_callback_capture",
          voiceSessionId: normalizeId(session),
          providerCallSid: session.providerCallSid || "",
          callbackDetails: {
            serviceNeeded: state.serviceNeeded,
            customerName: state.customerName,
            location: state.location,
            urgency: state.urgency,
            urgencyDetail: state.urgencyDetail,
            preferredTime: state.preferredTime,
          },
        },
      },
    },
    { upsert: true, returnDocument: "after" },
  );

  if (alert) {
    emit("emitAlertCreated", businessId, alert);
  }
  return alert;
};

const callbackConfirmationBody = ({ business, state }) => {
  const businessName = clean(business?.businessName, 120) || "the business";
  const service =
    state.serviceNeeded && state.serviceNeeded !== "Not provided"
      ? ` about ${state.serviceNeeded}`
      : "";
  const preference =
    state.preferredTime && state.preferredTime !== "Not provided"
      ? ` Your preferred timing is ${state.preferredTime}.`
      : "";
  return clean(
    `Hi${state.customerName && state.customerName !== "Not provided" ? ` ${state.customerName}` : ""}, this is ${businessName}. CallBackIQ received your callback request${service}.${preference} The team will follow up at this number. Reply STOP to opt out.`,
    1600,
  );
};

const sendCallbackConfirmation = async ({ session, state }) => {
  const business = session.business;
  const lead = session.lead;
  const conversation = session.conversation;
  const from = session.to || business?.phone;
  const to = session.from || lead?.phone;

  if (["sent", "sending", "suppressed"].includes(session.confirmationSmsStatus)) {
    state.confirmationSmsStatus = session.confirmationSmsStatus;
    state.confirmationSmsProviderMessageId =
      session.confirmationSmsProviderMessageId || "";
    return;
  }

  if (business?.features?.missedCallSmsEnabled === false || !from || !to) {
    session.confirmationSmsStatus = "suppressed";
    state.confirmationSmsStatus = "suppressed";
    await saveState(session, state);
    return;
  }

  const body = callbackConfirmationBody({ business, state });
  session.confirmationSmsStatus = "sending";
  state.confirmationSmsStatus = "sending";
  await saveState(session, state);

  try {
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
      session.confirmationSmsStatus = "suppressed";
      state.confirmationSmsStatus = "suppressed";
      await saveState(session, state);
      return;
    }

    const providerMessageId = sent?.sid || "";
    // Persist provider acceptance before local transcript logging. A database
    // logging failure must never turn an accepted SMS into a retryable state.
    session.confirmationSmsStatus = "sent";
    session.confirmationSmsSentAt = new Date();
    session.confirmationSmsProviderMessageId = providerMessageId;
    state.confirmationSmsStatus = "sent";
    state.confirmationSmsProviderMessageId = providerMessageId;
    await saveState(session, state);

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
    session.confirmationSmsStatus = "failed";
    state.confirmationSmsStatus = "failed";
    await saveState(session, state);
    logOperationalError("voice.callback_confirmation_sms_failed", error, {
      businessId: normalizeId(business),
      voiceSessionId: normalizeId(session),
      errorCode: error?.code || error?.name || "error",
    });
  }
};

const complete = async ({
  session,
  state,
  reply,
  sendConfirmationSms = true,
}) => {
  state.status = "completed";
  state.currentField = "";
  state.completedAt = new Date().toISOString();

  await updateLead({ session, state });
  await updateConversation({ session, state });
  await createCallbackAlert({ session, state });

  if (sendConfirmationSms) {
    await sendCallbackConfirmation({ session, state });
  }

  session.transferredToHuman = false;
  session.transferReason = `callback_captured:${state.reason}`.slice(0, 1000);
  session.summary = clean(
    `Callback captured. Service: ${state.serviceNeeded || "Not provided"}. Location: ${state.location || "Not provided"}. Urgency: ${state.urgencyDetail || state.urgency || "Not provided"}. Preferred time: ${state.preferredTime || "Not provided"}.`,
    4000,
  );
  await saveState(session, state);
  emit(
    "emitDashboardRefresh",
    normalizeId(session.business),
    "voice_callback_captured",
  );

  const confirmationMessage =
    state.confirmationSmsStatus === "sent"
      ? " I also sent a confirmation text."
      : state.confirmationSmsStatus === "failed"
        ? " The callback request was saved even though the confirmation text could not be sent."
        : "";

  return {
    reply:
      reply ||
      `Thank you. I created a priority callback request.${confirmationMessage} The team will follow up at this number.`,
    handoff: endPacket("callback-captured", state.reason),
    callbackCaptured: true,
  };
};

class VoiceCallbackService {
  static isActive(session) {
    return ACTIVE_STATUSES.has(
      session?.metadata?.callbackCapture?.status || "",
    );
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
    if (!session?.business || !session?.lead || !session?.conversation) {
      throw new Error(
        "Voice callback capture requires business, lead, and conversation context.",
      );
    }

    const active = this.isActive(session);
    const state = active
      ? { ...session.metadata.callbackCapture }
      : createState({
          session,
          reason,
          alertType,
          priority,
          requiredFields,
          seed,
          customerMessage,
          seedServiceFromMessage,
        });

    if (active && state.currentField) {
      captureField(state, state.currentField, customerMessage);
    }

    if (immediate) {
      return complete({
        session,
        state,
        reply: completionReply,
        sendConfirmationSms,
      });
    }

    const missing = nextMissingField(state);
    if (missing) {
      state.currentField = missing;
      state.status = `collecting_${missing}`;
      await saveState(session, state);
      return {
        reply: [clean(openingPrompt, 800), PROMPTS[missing]]
          .filter(Boolean)
          .join(" "),
        callbackCaptured: false,
      };
    }

    return complete({
      session,
      state,
      reply: completionReply,
      sendConfirmationSms,
    });
  }
}

export { DEFAULT_REQUIRED_FIELDS };
export default VoiceCallbackService;
