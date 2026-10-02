import { preserveSmsInterruptFacts, enforceSmsWorkflowResult, describeSmsWorkflowDecision, buildSmsRequestRevisionPatch, SMS_WORKFLOW_ACTIONS } from '../../src/services/messaging/smsWorkflowPolicy.service.js';
import { deriveSmsConversationPhase } from '../../src/services/messaging/smsConversationState.service.js';

const business = { timezone: 'America/New_York' };
const conversation = { status: 'open', bookingState: { status: 'not_started' } };
test.each(['plumbing', 'hvac', 'electrical', 'roofing', 'restoration', 'garage_door', 'locksmith', 'landscaping'])(
  '%s callback interruption retains address, preference and known service', trade => {
    const lead = { serviceNeeded: `${trade} repair`, urgency: 'high' };
    const result = preserveSmsInterruptFacts({ business: { ...business, businessType: trade }, lead, conversation,
      customerMessage: 'Please call me. My address is 123 Main St, Atlanta GA 30303. Tomorrow at 3pm works.',
      result: { messageCategory: 'human_requested', reply: 'Your callback request needs review.', serviceNeeded: '', address: '', preferredAppointmentTime: '' } });
    expect(result.address).toContain('123 Main');
    expect(result.preferredAppointmentTime).toContain('3:00 PM');
    expect(result.serviceNeeded).toBe(lead.serviceNeeded);
    expect(result.reply).toBe('Your callback request needs review.');
    expect(lead.address).toBeUndefined();
  });
test.each([
  { decision: 'no_reply', messageCategory: 'stop' },
  { messageCategory: 'appointment_status', serviceEligibility: { decision: 'unsupported' } },
])('does not reinterpret consent or service boundaries', result => {
  expect(preserveSmsInterruptFacts({ result, business, lead: {}, conversation, customerMessage: '123 Main St tomorrow' })).toBe(result);
});
test.each([
  { decision: 'no_reply', actionType: 'no_reply', messageCategory: 'service_details', reply: '' },
  { decision: 'send', actionType: 'confirm_booking', messageCategory: 'appointment_preference', reply: 'You are booked.' },
  { decision: 'send_fixed_response', actionType: 'send_fixed_response', guardrail: { skipAI: false, reason: 'ai_pipeline_error' } },
])('unusable model output enters actionable review: %j', invalid => {
  const result = enforceSmsWorkflowResult({ guardrail: { skipAI: false }, ...invalid });
  expect(result).toMatchObject({ decision: 'send_fixed_response', intakeReady: false, shouldAlertOwner: true,
    handoff: { required: true, reason: 'intake_unclear' } });
  expect(result.reply).not.toMatch(/you are booked|shortly|right away/i);
  expect(describeSmsWorkflowDecision({ result }).action).toBe('staff_review');
});
test.each(['stop', 'possible_spam', 'off_topic', 'abusive', 'prompt_injection'])('preserves intentional %s silence', messageCategory => {
  const result = { decision: 'no_reply', messageCategory, guardrail: { skipAI: false } };
  expect(enforceSmsWorkflowResult(result)).toBe(result);
});
test('deterministic safety and booking responses retain their existing authority', () => {
  const result = { decision: 'send_fixed_response', actionType: 'send_fixed_response', reply: 'Business approval is required.', guardrail: { skipAI: true } };
  expect(enforceSmsWorkflowResult(result)).toBe(result);
});
test('a rejected model action cannot overwrite the saved service or address', () => {
  const result = enforceSmsWorkflowResult({ actionType: 'confirm_booking', serviceNeeded: 'invented service', address: 'invented address',
    guardrail: { skipAI: false } }, { lead: { serviceNeeded: 'AC repair', address: '123 Main St' } });
  expect(result).toMatchObject({ serviceNeeded: 'AC repair', address: '123 Main St', handoff: { reason: 'intake_unclear' } });
});
test.each([
  [{ decision: 'no_reply' }, 'suppress_reply'],
  [{ messageCategory: 'emergency', handoff: { required: true } }, 'safety_response'],
  [{ serviceEligibility: { decision: 'unsupported' } }, 'service_boundary'],
  [{ handoff: { reason: 'intake_complete', required: true } }, 'request_business_approval'],
  [{ handoff: { required: true } }, 'staff_review'],
  [{ messageCategory: 'pricing_request' }, 'answer_question'],
  [{ actionType: 'request_information' }, 'ask_missing_detail'],
  [{ actionType: 'acknowledge' }, 'update_request'],
])('records one bounded action without claiming delivery or staff acceptance', (result, action) => {
  const decision = describeSmsWorkflowDecision({ result, conversation });
  expect(decision.action).toBe(action);
  expect(SMS_WORKFLOW_ACTIONS).toContain(decision.action);
  expect(decision).not.toHaveProperty('delivered');
  expect(decision).not.toHaveProperty('staffAccepted');
});
test('a corrected address invalidates only an uncommitted offer and retains intake details', () => {
  const context = { bookingState: { status: 'offering_slots' }, conversationMemory: { recoveryIntake: { triageAnswer: 'No overflow', submitted: true } } };
  const patch = buildSmsRequestRevisionPatch({ result: { messageCategory: 'appointment_status', address: '456 Oak St' }, lead: { address: '123 Main St' }, conversation: context });
  expect(patch).toMatchObject({ 'bookingState.status': 'not_started', 'bookingState.offeredSlots': [],
    'conversationMemory.address': '456 Oak St', 'conversationMemory.recoveryIntake': { triageAnswer: 'No overflow', submitted: false } });
  context.bookingState.appointment = 'existing-appointment';
  expect(buildSmsRequestRevisionPatch({ result: { address: '456 Oak St' }, lead: { address: '123 Main St' }, conversation: context })).toEqual({ 'conversationMemory.address': '456 Oak St' });
});
test('pending staff review survives a subsequent customer turn without overriding actual ownership or booking', () => {
  const pending = { ...conversation, orchestration: { handoffReason: 'intake_unclear' } };
  expect(deriveSmsConversationPhase(pending)).toBe('handoff_pending');
  expect(deriveSmsConversationPhase({ ...pending, humanTakeover: true })).toBe('human_takeover');
  expect(deriveSmsConversationPhase({ ...pending, bookingState: { status: 'booked' } })).toBe('confirmed');
});
