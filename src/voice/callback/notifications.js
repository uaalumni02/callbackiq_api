import { upsertCallbackReview } from '../../services/stateTransitions/voice.js';
import { saveStateDocument } from '../../services/stateTransitions/documents.js';
import "../../services/booking/customerAddress.service.js";
import { ownerTextSuppressionReason } from "../../services/messaging/ownerTextPolicy.service.js";
import "../../services/staffReviewPolicy.service.js";
import "mongoose";
import Alert from "../../models/alert.js";
import Message from "../../models/message.js";
import "../../models/voiceSession.js";
import { logOperationalError } from "../../helpers/logging/safeLogger.js";
import "../../helpers/ai/tools/validateServiceArea.tool.js";
import "../../services/socket.service.js";
import { sendSms } from "../../services/twilioSmsService.js";
import "../../services/customerCommitmentSafety.service.js";
import "../voiceAvailability.service.js";
import "../voiceInput.service.js";
import VoiceLineTypeService from "../voiceLineType.service.js";
import "../voiceMetrics.service.js";
import { isUsableCallerId, normalizePhoneToE164 } from "../voicePhone.service.js";
import { assertVoiceTurnActive } from "../../services/voiceTurnContext.service.js";
import { normalizeId, dueAtForPriority, clean, latestCustomerMessage, skippedValue } from './policy.js';
import { emit, persistSessionSet } from './persistence.js';
const createCallbackAlert = async ({ session, state, canceled = false }) => {
  assertVoiceTurnActive();
  const businessId = normalizeId(session.business);
  const leadId = normalizeId(session.lead);
  const conversationId = normalizeId(session.conversation);
  const suffix = canceled ? "canceled" : state.reason;
  const dedupeKey = `voice_callback:${normalizeId(session)}:${suffix}`.slice(0, 200);
  const priority = canceled ? "low" : state.priority;
  const alert = await upsertCallbackReview({ Alert, businessId, canceled, clean, conversationId, dedupeKey, dueAtForPriority, isUsableCallerId, latestCustomerMessage, leadId, normalizeId, priority, session, state });
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
  const english = `Hi${state.customerName && !skippedValue(state.customerName) ? ` ${state.customerName}` : ""}, this is ${businessName}. We received your callback request${service}.${preference} The request has been flagged for the team. A callback time is not guaranteed. Reply STOP to opt out.`;
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
        await saveStateDocument(conversation);
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

export { createCallbackAlert, callbackConfirmationBody, persistConfirmationState, sendCallbackConfirmation };
