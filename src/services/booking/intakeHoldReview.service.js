import { rejectStaleIntakeHold } from './intakeHoldTransition.repository.js';
export { rejectStaleIntakeHold };
import Conversation from '../../models/conversation.js';
import Lead from '../../models/lead.js';
import VoiceSession from '../../models/voiceSession.js';
import { normalizePhoneToE164 } from '../../voice/voicePhone.service.js';
import { extractCustomerPostalCode } from './customerAddress.service.js';
import { intakeApprovalKey, intakeReviewVersion, manualIntakeSubmitted } from './intakeReviewContext.service.js';

const isIntakeHold = (appointment) => /^intake-approval:[a-f0-9]{24}:[a-f0-9]{24}$/.test(appointment.idempotencyKey);
const conflict = (message, code) => Object.assign(new Error(message), { statusCode: 409, code });

export async function assertVoiceReviewIdle(businessId, conversationId) {
  const activeCall = await VoiceSession.exists({ business: businessId, conversation: conversationId,
    status: { $in: ['routing', 'connecting', 'active', 'capturing_callback', 'safety_escalated', 'transferring', 'completing'] },
  });
  if (activeCall) throw conflict('The customer is still on a voice call. Review the completed call before approving.', 'INTAKE_VOICE_ACTIVE');
}


export async function assertIntakeHoldCurrent(appointment) {
  if (!isIntakeHold(appointment)) return;
  if (!appointment.intakeReviewVersion) await rejectStaleIntakeHold(appointment);

  await assertVoiceReviewIdle(appointment.business, appointment.conversation);
  const [conversation, lead] = await Promise.all([
    Conversation.findOne({ _id: appointment.conversation, business: appointment.business }).lean(),
    Lead.findOne({ _id: appointment.lead, business: appointment.business }).lean(),
  ]);
  const address = String(lead?.address || '').trim();
  if (!conversation || !lead || conversation.status !== 'open' ||
      String(conversation.lead) !== String(appointment.lead) ||
      (conversation.bookingState?.appointment && String(conversation.bookingState.appointment) !== String(appointment._id)) ||
      !manualIntakeSubmitted(conversation) || intakeApprovalKey(conversation) !== appointment.idempotencyKey ||
      intakeReviewVersion(conversation, lead) !== appointment.intakeReviewVersion ||
      normalizePhoneToE164(conversation.customerPhone) !== normalizePhoneToE164(appointment.customerPhone) ||
      !address || appointment.address?.street !== address || appointment.address?.postalCode !== extractCustomerPostalCode(address)) {
    await rejectStaleIntakeHold(appointment);
  }
}
