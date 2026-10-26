/**
 * Canonical turn frame for existing SMS and voice business logic. This is an
 * observation/planning contract; it does not make a side-effect decision.
 * All source-specific understanding feeds the same fields.
 */
import { detectDialogAct, evidenceSnapshot } from './dialogPolicy.js';
import { phaseFor } from './dialogState.js';
const stable = values => [...new Set(values.filter(Boolean))].slice(0,12);
export function deriveTurnFrame({ customerMessage, channel = 'sms', lead = {}, conversation = {},
  classification = null, voiceUnderstanding = null, semantic = null } = {}) {
  const snapshot = evidenceSnapshot({ lead, conversation, channel });
  const intents = classification?.intents || {};
  const voiceIntent = String(voiceUnderstanding?.intent || '');
  const questions = stable([
    detectDialogAct(customerMessage,semantic),
    intents.pricing || voiceIntent==='pricing' ? 'pricing_question' : '',
    intents.availabilityInquiry ? 'availability_question' : '',
    intents.status || voiceIntent==='existing_job' ? 'existing_job_status' : '',
  ]);
  const controls = stable([
    intents.cancel ? 'cancel_request' : '', intents.reschedule ? 'reschedule_request' : '',
    intents.human || voiceIntent==='human' ? 'human_request' : '',
    intents.callback || voiceIntent==='callback' ? 'callback_request' : '',
    intents.correction ? 'correction' : '', intents.newService ? 'new_service' : '',
  ]);
  const facts = stable([
    classification?.entities?.serviceNeeded || voiceUnderstanding?.entities?.service ? 'service' : '',
    classification?.entities?.range ? 'date' : '',
    classification?.entities?.timePreference?.timeOfDay || classification?.entities?.timePreference?.exactMinutes != null ? 'time' : '',
    voiceUnderstanding?.entities?.location ? 'location' : '',
  ]);
  // A frame is context, not authorization. Preserve compound turns as arrays.
  const route = snapshot.humanOwns ? 'human_owner' : snapshot.closed ? 'closed' :
    voiceIntent==='emergency' ? 'safety_guard' : controls.length ? 'existing_control_pipeline' :
    snapshot.booked || snapshot.pendingOffer ? 'authoritative_booking_pipeline' :
    facts.length ? 'existing_intake_pipeline' : questions.length ? 'question_router' : 'semantic_intake_fallback';
  return Object.freeze({
    version:3,channel:channel==='voice'?'voice':'sms', phase:phaseFor({conversation,snapshot}),
    questions, controls, factKinds:facts, route, snapshot,
    allowedToConfirm:false,allowedToDispatch:false,allowedToAssumeStaffAccepted:false,
  });
}
