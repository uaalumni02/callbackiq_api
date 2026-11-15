import { createRequestBookingGuard } from '../requestBookingPersistence.service.js';
import { businessHoursQuestion, classifySmsIntent, controlMessage, isCoverageQuestion, selectOfferedSlot, updateRequestQuestions } from './context.js';

export async function classifyRequestContext(context) {
  const { lead, conversation, business, text, now, channel, session, reviewOnly, capturedAddress, turnId, recentMessages } = context;
if (typeof lead.save !== 'function' || typeof conversation.save !== 'function') return { completed: true, value: null };
  const classification = classifySmsIntent({ business, lead, conversation, customerMessage: text, now });
  const coverageQuestion = isCoverageQuestion(text);
  if (controlMessage.test(text) || businessHoursQuestion.test(text) ||
      ['human', 'callback', 'cancel', 'reschedule', 'status'].some(intent => classification.intents?.[intent])) return { completed: true, value: null };
  if (channel === 'voice' && (session?.metadata?.callbackCapture?.status || session?.metadata?.currentUnderstanding?.language === 'es' || session?.metadata?.currentUnderstanding?.language === 'other')) return { completed: true, value: null };
  const bookingActive = reviewOnly || ['offering_slots', 'awaiting_confirmation', 'booking', 'pending_business_confirmation', 'booked', 'human_takeover'].includes(conversation.bookingState?.status);
  // Slot selections and confirmations still belong to the booking engine,
  // including expiry and availability rechecks. A missing intake memory is not
  // evidence that a numeric option is a newly supplied service fact.
  // Use the same response classification as that engine: compound replies
  // such as "Yes, confirm" must not be consumed as extra intake details.
  if (bookingActive && !reviewOnly && !classification.intents?.availabilityInquiry && !capturedAddress && !classification.entities?.serviceNeeded &&
      (selectOfferedSlot(text, conversation.bookingState?.offeredSlots || [], business.timezone || 'America/New_York') || /^(?:option\s*)?\d+[.! ]*$/i.test(text) || (classification.response?.affirmative || classification.response?.negative) || classification.intents?.scheduling)) return { completed: true, value: null };
  const checkActive = createRequestBookingGuard(channel);
  const timezone = business.timezone || 'America/New_York';
  const journeyKey = conversation.orchestration?.recoveryJourneyKey || '';
  const oldState = conversation.conversationMemory?.recoveryIntake;
  const state = oldState?.journeyKey === journeyKey ? structuredClone(oldState) : { journeyKey };
  if (classification.intents?.callbackDeclined) {
    state.contactPreference = { callback: 'declined', preferredChannel: /\btext\s+me\s+instead\b/i.test(text) ? 'sms' : (state.contactPreference?.preferredChannel || ''), sourceTurnId: String(turnId || '') };
  } else if (classification.intents?.callback) {
    state.contactPreference = { callback: 'requested', preferredChannel: 'phone', sourceTurnId: String(turnId || '') };
  }
  const questions = updateRequestQuestions(state, text, turnId);
  if (classification.intents?.availabilityInquiry) state.pendingAvailabilityQuestion = text.slice(0, 500);
  const oldPreference = state.preferredAppointmentTime ?? lead.preferredAppointmentTime ?? '';
  const oldService = state.serviceNeeded ?? lead.serviceNeeded ?? '';
  const oldAddress = state.address || lead.address || '';
  if (questions.clarificationAnswer) classification.intents.pricing = questions.pricing;
  // A prepared but unsent question is not a question the customer received.
  // Keep the outstanding triage field and ask again after transport recovers.
  if (channel === 'sms') {
    const lastOutbound = recentMessages.filter(message => message.direction === 'outbound').at(-1);
    if (lastOutbound && ['suppressed', 'failed', 'undelivered'].includes(lastOutbound.deliveryStatus || lastOutbound.status)) {
      if (state.clogPending && /(?:overflowing or backing up into other fixtures|backing up into any other)/i.test(lastOutbound.body || '')) state.clogAsked = false;
      if (state.triagePending && /(?:leak|water coming|substance)/i.test(lastOutbound.body || '')) state.triageAsked = false;
      if (state.tradeQualification?.pending && lastOutbound.body === state.tradeQualification.question) state.tradeQualification.asked = false;
    }
  }
  return { completed: false, context: { classification, coverageQuestion, bookingActive, timezone, checkActive, journeyKey, oldState, state, questions, oldPreference, oldService, oldAddress } };
}
