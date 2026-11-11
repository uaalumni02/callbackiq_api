import { GENERAL_HELP_REPLY, VOICE_URGENCY_RANK, VoiceUnderstandingService, assertVoiceTurnActive, captureCallback, classifyOperationalUrgency, clean, handleVoiceExit, logOperationalError, preserveVoiceUrgency, updateTurnGuards } from './context.js';

export async function assessSafety(context) {
  const { signal, customerMessage, session } = context;
assertVoiceTurnActive();
    if (signal?.aborted) throw signal.reason || new Error("Voice turn aborted.");
    const text = clean(customerMessage, 4000);
    const business = session?.business;
    const lead = session?.lead;
    const conversation = session?.conversation;
    if (!business || !conversation) {
      throw new Error("Voice agent requires business and conversation context.");
    }
    if (!text) return { completed: true, value: { reply: GENERAL_HELP_REPLY } };
    const exit = await handleVoiceExit({ session, customerMessage: text });
    if (exit) return { completed: true, value: exit };

    const guard = updateTurnGuards(session, text);
    const recentMessages = (session.transcript || []).slice(-10).map((entry) => ({
      direction: entry.role === "customer" ? "inbound" : "outbound",
      body: entry.text,
      createdAt: entry.at,
    }));

    let safety;
    let understanding;
    try {
      understanding = await VoiceUnderstandingService.classifyVoiceTurn({
        customerMessage: text,
        recentMessages,
        signal,
      });
      assertVoiceTurnActive();
      const deterministicUrgency = classifyOperationalUrgency(text);
      const understoodUrgency = String(
        understanding?.entities?.urgency || "",
      ).toLowerCase();
      const urgencyCandidate =
        VOICE_URGENCY_RANK[deterministicUrgency] >=
        VOICE_URGENCY_RANK[understoodUrgency]
          ? deterministicUrgency
          : understoodUrgency;
      if (urgencyCandidate) {
        understanding.entities = {
          ...(understanding.entities || {}),
          urgency: urgencyCandidate,
        };
        await preserveVoiceUrgency(lead, urgencyCandidate);
      }

      session.metadata = { ...(session.metadata || {}), currentUnderstanding: understanding };
      safety = understanding.safety;
      if (understanding.usage) {
        session.openAiUsage = {
          inputTokens: Number(session.openAiUsage?.inputTokens || 0) + Number(understanding.usage.input_tokens || 0),
          outputTokens: Number(session.openAiUsage?.outputTokens || 0) + Number(understanding.usage.output_tokens || 0),
        };
      }
    } catch (error) {
      if (error?.code === "VOICE_STALE_TURN" || signal?.aborted) throw error;
      logOperationalError("voice.safety_assessment_failed", error, {
        businessId: business._id,
        voiceSessionId: session._id,
      });
      return { completed: true, value: captureCallback({
        session,
        customerMessage: text,
        reason: "safety_assessment_unavailable",
        alertType: "low_ai_confidence",
        priority: "high",
        seedServiceFromMessage: true,
        openingPrompt:
          "I can’t safely continue automation until the team reviews this request. I’ll preserve the details for a priority callback.",
      }) };
    }
  return { completed: false, context: { text, business, lead, conversation, guard, recentMessages, safety, understanding } };
}
