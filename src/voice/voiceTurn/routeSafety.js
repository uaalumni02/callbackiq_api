import { getEmergencyReply } from "../../helpers/ai/aiGuardrails.js";
import { saveStateDocument } from '../../services/stateTransitions/documents.js';
import { AlertService, assertVoiceTurnActive, captureCallback, captureTurnFacts, classifySmsIntent, observeCustomerConstraint, respectCustomerConstraints } from './context.js';
export async function routeSafety(context) {
  const { conversation, lead, text, safety, business, session, turnId } = context;
const constraintResult = await observeCustomerConstraint({ conversation, lead, customerMessage: text, channel: 'voice' });
    if (constraintResult && !safety?.isEmergency && !safety?.shouldSendSafetyReply) {
      assertVoiceTurnActive();
      await AlertService.createAIReviewAlert({ businessId: business._id, leadId: lead?._id,
        conversationId: conversation._id, providerMessageId: `voice-constraint:${session._id}:${turnId || session.transcript?.length || 0}`,
        customerPhone: lead?.phone || conversation.customerPhone, result: constraintResult });
      assertVoiceTurnActive();
      return { completed: true, value: { reply: constraintResult.reply } };
    }
    if (safety?.hazardType === "self_harm") safety.reply = getEmergencyReply("self_harm");
    if (safety?.reply) safety.reply = respectCustomerConstraints(safety.reply, { conversation, customerMessage: text });
    if (safety?.needsReview || safety?.isEmergency || safety?.shouldSendSafetyReply) {
      const facts = captureTurnFacts({ customerMessage: text, business, lead,
        classification: classifySmsIntent({ customerMessage: text, business, lead, conversation }) });
      if (lead && Object.keys(facts).length) {
        assertVoiceTurnActive();
        Object.assign(lead, facts);
        await saveStateDocument(lead);
        assertVoiceTurnActive();
      }
    }
    if (safety?.needsReview) {
      const assessment = safety.reviewAssessment;
      assertVoiceTurnActive();
      await AlertService.createAIReviewAlert({ businessId: business._id, leadId: lead?._id,
        conversationId: conversation._id, providerMessageId: `voice-safety-review:${session._id}:${turnId || session.transcript?.length || 0}`,
        customerPhone: lead?.phone || conversation.customerPhone,
        result: { ...assessment, messageCategory: assessment.category, summary: assessment.reason,
          alertTitle: "Customer safety concern needs review", alertMessage: text } });
      assertVoiceTurnActive();
      return { completed: true, value: { reply: safety.reply } };
    }
    if (safety?.isEmergency || safety?.shouldSendSafetyReply) {
      if (lead) {
        lead.urgency = "emergency";
        lead.notes = `${lead.notes || ""}\nVoice safety escalation: ${text}`
          .trim().slice(0, 2000);
        assertVoiceTurnActive();
        await saveStateDocument(lead);
      }
      return { completed: true, value: captureCallback({
        session,
        customerMessage: text,
        reason: `safety_emergency:${safety?.hazardType || "other"}`,
        alertType: "safety_emergency",
        priority: "critical",
        seed: {
          serviceNeeded: lead?.serviceNeeded || `Potential ${safety?.hazardType || "safety"} emergency`,
          urgency: "emergency",
          urgencyDetail: text,
          location: lead?.address,
          preferredTime: lead?.preferredAppointmentTime,
        },
        immediate: true,
        sendConfirmationSms: false,
        completionReply:
          safety?.reply ||
          "If anyone is in immediate danger, hang up and call 911 now. I flagged this for urgent review, but do not wait for a callback or use this service instead of emergency services.",
      }) };
    }
  return { completed: false, context: {  } };
}
