import { MAX_ABUSIVE_TURNS, MAX_REPEATED_INPUTS, VoiceTranscriptService, bookingQuestionReply, captureCallback, containsAbuse, isAmbiguousServiceLoss, isRepeatIntent, resetFallbackGuard, schedulingQuestionReply, serviceLossQuestion } from './context.js';

export async function routeRecovery(context) {
  const { text, conversation, business, lead, guard, session, understanding } = context;
const questionReply = bookingQuestionReply({ customerMessage: text, conversation });
    if (questionReply) return { completed: true, value: { reply: questionReply } };
    if (isAmbiguousServiceLoss(text)) return { completed: true, value: { reply: serviceLossQuestion } };

    const schedulingReply = schedulingQuestionReply({ customerMessage: text, business, lead });
    if (schedulingReply) {
      resetFallbackGuard(guard);
      return { completed: true, value: { reply: schedulingReply, outcome: "direct_answer_resolved" } };
    }

    if (isRepeatIntent(text)) {
      resetFallbackGuard(guard);
      const previous = VoiceTranscriptService.getLastAssistantText(session);
      return { completed: true, value: {
        reply: previous
          ? `Of course. ${previous}`
          : "Of course. Tell me what service you need, or say callback for team follow-up.",
      } };
    }

    if (guard.repeatedInputCount >= MAX_REPEATED_INPUTS) {
      return { completed: true, value: captureCallback({
        session,
        customerMessage: text,
        reason: "voice_conversation_loop",
        alertType: "low_ai_confidence",
        priority: "medium",
        seedServiceFromMessage: true,
        openingPrompt:
          "I may not be understanding you correctly. I’ll preserve the request for a team member instead of keeping you in a loop.",
      }) };
    }

    if (guard.abusiveTurnCount >= MAX_ABUSIVE_TURNS) {
      resetFallbackGuard(guard);
      return { completed: true, value: captureCallback({
        session,
        customerMessage: text,
        reason: "abusive_or_distressed_caller",
        alertType: "angry_customer",
        priority: "high",
        seed: { serviceNeeded: "Distressed or abusive caller follow-up" },
        openingPrompt:
          "I want to get this to the right person. I’ll create a priority callback request and end the automated conversation after the details are confirmed.",
      }) };
    }

    if (understanding?.directedAbuse || containsAbuse(text)) {
      resetFallbackGuard(guard);
      const strikes = Number(session.metadata?.directedAbuseStrikes || 0) + 1;
      session.metadata.directedAbuseStrikes = strikes;
      if (strikes >= 2) {
        return { completed: true, value: captureCallback({ session, customerMessage: text, reason: "repeated_directed_abuse", alertType: "angry_customer", priority: "high", seedServiceFromMessage: true, openingPrompt: "I hear that you’re upset. I’ll save this for a team member to handle directly." }) };
      }
      return { completed: true, value: { reply: "I hear that you’re upset. Tell me the service issue, or say callback and I’ll save it for team review." } };
    }

    if (understanding?.language === "es" || guard.nonEnglishTurnCount >= 1) {
      resetFallbackGuard(guard);
      const entities = understanding?.entities || {};
      return { completed: true, value: captureCallback({
        session, customerMessage: text, reason: "language_barrier_spanish",
        alertType: "human_requested", priority: "high",
        seed: { language: "es", serviceNeeded: entities.service || "Solicitud en español", customerName: entities.name, location: entities.location || entities.city || entities.postalCode, urgency: entities.urgency, preferredTime: entities.preference },
        seedServiceFromMessage: !entities.service,
        openingPrompt: "Entiendo. Guardaré su solicitud para que el equipo la revise. No puedo garantizar cuándo habrá alguien disponible para llamar. ¿Qué nombre debo poner en la solicitud?",
      }) };
    }
  return { completed: false, context: {  } };
}
