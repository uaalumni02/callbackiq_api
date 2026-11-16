import { stageVoiceControlHandoff } from '../../services/stateTransitions/voice.js';
import { saveStateDocument } from '../../services/stateTransitions/documents.js';
import { AlertService, VoiceCallbackService, applyCustomerAddressRevision, assertVoiceTurnActive, captureCallback, guardServiceRequest, handleCompoundCustomerTurn, handleConversationControl, isCallbackRequest, maybeAnswerDialogQuestion, planCustomerTurn, recordPilotMetric, resetFallbackGuard, schedulingQuestionReply, toSpokenReply } from './context.js';
export async function routeConversationControl(context) {
  const { session, text, business, lead, guard, turnId, conversation, recentMessages, understanding, signal } = context;
if (VoiceCallbackService.isActive(session)) {
      const detour = schedulingQuestionReply({ customerMessage: text, business, lead });
      if (detour) return { completed: true, value: { reply: detour, outcome: "direct_answer_resolved" } };
      resetFallbackGuard(guard);
      return { completed: true, value: captureCallback({ session, customerMessage: text }) };
    }
    const latestCustomerTurn = [...(session.transcript || [])].reverse().find((entry) => entry.role === "customer");
    const requestTurnId = `voice:${session._id}:${latestCustomerTurn?.at || turnId || session.transcript?.length || 0}`;
    const turnPlan = planCustomerTurn({ business, lead, conversation, customerMessage: text });
    const compound = await handleCompoundCustomerTurn({ business, lead, conversation, customerMessage: text, turnId: requestTurnId, channel: 'voice' });
    if (compound) {
      if (compound.handoff?.required) {
        assertVoiceTurnActive();
        await AlertService.createHumanHandoffAlert({ businessId: business._id, leadId: lead?._id,
          conversationId: conversation._id, customerPhone: lead?.phone || conversation.customerPhone,
          customerMessage: text, lead, result: compound, providerMessageId: `voice-compound:${session._id}:${turnId || session.transcript?.length || 0}` });
        assertVoiceTurnActive();
        stageVoiceControlHandoff({ conversation });
        conversation.markModified?.('orchestration');
        await saveStateDocument(conversation);
      }
      resetFallbackGuard(guard);
      return { completed: true, value: { reply: toSpokenReply(compound.reply) } };
    }
    // A callback is an exit from automated scheduling, including an in-progress
    // booking. Compound slot acceptance above still records an explicit choice.
    if (isCallbackRequest(text)) {
      resetFallbackGuard(guard);
      recordPilotMetric(session, "exit_requested", 1, { exit: "callback" });
      recordPilotMetric(session, "exit_honored_one_turn", 1, { exit: "callback" });
      return { completed: true, value: captureCallback({ session, customerMessage: text,
        reason: "customer_requested_callback", alertType: "human_requested",
        openingPrompt: "Absolutely. I’ll collect and confirm the details for the team." }) };
    }
    if (!turnPlan.withdrawal && turnPlan.confirmation) await applyCustomerAddressRevision({ business, lead, conversation, customerMessage: text, turnId: requestTurnId, recentMessages });
    const changedService = !turnPlan.withdrawal && turnPlan.classified.entities?.serviceNeeded &&
      (turnPlan.classified.intents?.correction || turnPlan.classified.intents?.newService);
    const control = changedService || turnPlan.additionalRequest ? null : await handleConversationControl({ business, lead, conversation, customerMessage: text, channel: "voice" });
    if (control) { resetFallbackGuard(guard); return { completed: true, value: { reply: toSpokenReply(control.reply) } }; }

    const serviceGuard = await guardServiceRequest({ business, lead, conversation, customerMessage: text, channel: 'voice', turnId, recentMessages,
      semanticAssessment: understanding?.entities?.service ? { serviceNeeded: understanding.entities.service, confidence: understanding.confidence } : null });
    if (serviceGuard) return { completed: true, value: { reply: toSpokenReply(serviceGuard.reply) } };

    const dialogAnswer = ['es', 'other'].includes(understanding?.language) ? null :
      await maybeAnswerDialogQuestion({ business, lead, conversation,
        customerMessage: text, channel: 'voice', recentMessages, signal });
    if (dialogAnswer) return { completed: true, value: { ...dialogAnswer, reply: toSpokenReply(dialogAnswer.reply),
      messageCategory: 'appointment_status' } };
  return { completed: false, context: {  } };
}
