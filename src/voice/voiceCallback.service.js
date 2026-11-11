import "../services/booking/customerAddress.service.js";
import "../services/messaging/ownerTextPolicy.service.js";
import "../services/staffReviewPolicy.service.js";
import "mongoose";
import "../models/alert.js";
import "../models/message.js";
import "../models/voiceSession.js";
import "../helpers/logging/safeLogger.js";
import "../helpers/ai/tools/validateServiceArea.tool.js";
import "../services/socket.service.js";
import "../services/twilioSmsService.js";
import "../services/customerCommitmentSafety.service.js";
import "./voiceAvailability.service.js";
import { extractCallbackDetails, isCancelIntent, isNo, isRepeatIntent, isYes, parseCorrection } from "./voiceInput.service.js";
import "./voiceLineType.service.js";
import "./voiceMetrics.service.js";
import "./voicePhone.service.js";
import { assertVoiceTurnActive } from "../services/voiceTurnContext.service.js";
import { ACTIVE_STATUSES, DEFAULT_REQUIRED_FIELDS, clean, promptFor, FIELD_LABELS, recordCallbackMetric } from './callback/policy.js';
import { createState, recoverCallAddress, nextMissingField, applyExtractedDetails, validFieldValue, markSkipped } from './callback/state.js';
import { reconcileLead, saveState } from './callback/persistence.js';
import { buildReadback, complete, cancelCapture, handleQuestionDetour, correctionFromDeclaration, applyCorrection, applyCurrentField } from './callback/actions.js';
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

export { DEFAULT_REQUIRED_FIELDS } from './callback/policy.js';
export default VoiceCallbackService;
