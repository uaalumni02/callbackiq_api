import { handleRecoveryIntake } from '../../services/booking/recoveryIntake.service.js';
import { assertVoiceTurnActive, beginValuation, finishValuation, resetFallbackGuard, toSpokenReply } from './context.js';

export async function captureIntake(context) {
  const { lead, business, session, text, understanding, conversation, turnId, recentMessages, guard } = context;
assertVoiceTurnActive();
    const valuationTicket = await beginValuation(lead, business._id);
    const valuedLead = await finishValuation(valuationTicket, { businessId: business._id,
      evidence: [...(session.transcript || []).filter(entry => entry.role === "customer").slice(-20).map(entry => entry.text), text].join("\n"),
      proposedService: lead?.serviceNeeded === 'Unknown' ? '' : lead?.serviceNeeded || '' });
    assertVoiceTurnActive();
    if (valuedLead && lead) {
      lead.estimatedValue = valuedLead.estimatedValue; lead.valuation = valuedLead.valuation;
      lead.valuationVersion = valuedLead.valuationVersion;
      for (const path of ['estimatedValue', 'valuation', 'valuationVersion']) lead.unmarkModified?.(path);
    }

    const semanticAssessment = Number.isFinite(understanding?.confidence) &&
      understanding.confidence >= 60 &&
      ["service_request", "booking", "pricing"].includes(understanding.intent) &&
      typeof understanding.entities?.service === "string" && understanding.entities.service.trim()
      ? { isInScope: true, confidence: understanding.confidence, serviceNeeded: understanding.entities.service }
      : null;
    const intake = await handleRecoveryIntake({ business, lead, conversation, customerMessage: text, channel: "voice", session, turnId, semanticAssessment, recentMessages });
    if (intake) { resetFallbackGuard(guard); return { completed: true, value: { reply: toSpokenReply(intake.reply), ...(intake.outcome ? { outcome: intake.outcome } : {}) } }; }
  return { completed: false, context: {  } };
}
