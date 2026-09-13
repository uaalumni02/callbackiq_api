// Unit boundary: eligibility decisions are tested for propagation here; the
// existing eligibility journey suites exercise the catalog policy itself.
jest.mock('../../src/services/serviceEligibility/serviceEligibility.service.js', () => ({ guardServiceRequest: jest.fn() }), { virtual: true });
jest.mock('../../src/services/messaging/smsIntentClassifier.service.js', () => ({ classifySmsIntent: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/searchServices.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/getAvailability.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/validateServiceArea.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { createHumanHandoffAlert: jest.fn() } }));
jest.mock('../../src/services/booking/approvedServiceEstimate.service.js', () => ({ getApprovedServiceEstimate: jest.fn() }));
jest.mock('../../src/services/messaging/uncertainReply.service.js', () => ({ resetUncertainTurns: jest.fn() }));
import { handleRecoveryIntake } from '../../src/services/booking/recoveryIntake.service.js';
import { guardServiceRequest } from '../../src/services/serviceEligibility/serviceEligibility.service.js';
import { classifySmsIntent } from '../../src/services/messaging/smsIntentClassifier.service.js';
import getAvailability from '../../src/helpers/ai/tools/getAvailability.tool.js';
import searchServices from '../../src/helpers/ai/tools/searchServices.tool.js';
import validateServiceArea from '../../src/helpers/ai/tools/validateServiceArea.tool.js';
import AlertService from '../../src/services/alert.service.js';

function context(channel, state = {}) {
  return {
    business: { _id: 'business-coverage', timezone: 'America/New_York', features: { aiBookingEnabled: false } },
    lead: { _id: 'lead-coverage', serviceNeeded: 'pipe leak', urgency: 'medium', save: jest.fn().mockResolvedValue(null) },
    conversation: {
      _id: 'conversation-coverage', status: 'open', bookingState: { status: 'not_started' },
      conversationMemory: { recoveryIntake: { journeyKey: '', started: true, ...state } },
      save: jest.fn().mockResolvedValue(null),
      set(path, value) { this.conversationMemory.recoveryIntake = value; },
    },
    channel, session: { _id: 'voice-coverage' }, turnId: 'turn-coverage',
    now: new Date('2026-09-06T14:00:00Z'),
  };
}
const stateOf = c => c.conversation.conversationMemory.recoveryIntake;
beforeEach(() => {
  jest.clearAllMocks();
  guardServiceRequest.mockReset().mockResolvedValue(null);
  classifySmsIntent.mockReturnValue({ entities: { serviceNeeded: 'pipe leak' }, intents: {} });
  searchServices.mockResolvedValue([{ id: 'offering-coverage', score: 1 }]);
  validateServiceArea.mockResolvedValue({ supported: true });
  getAvailability.mockResolvedValue({ supportedServiceArea: true, slots: [{ startAt: '2026-09-08T12:00:00Z', endAt: '2026-09-08T13:00:00Z' }] });
  AlertService.createHumanHandoffAlert.mockResolvedValue({ _id: 'alert-coverage' });
});

describe.each(['sms', 'voice'])('%s recovery intake regression', channel => {
  test.each(['Water is actively leaking', 'It stopped leaking, but water is still leaking', 'It only leaks during use; however water is gushing now'])('retains active evidence: %s', async customerMessage => {
    const c = context(channel, { triagePending: true, triageAsked: true, field: 'leak_activity' });
    const result = await handleRecoveryIntake({ ...c, customerMessage });
    expect(c.lead.urgency).toBe('high');
    expect(stateOf(c)).toMatchObject({ triageResolved: true, triagePending: false, leakPattern: 'active', triageAnswer: customerMessage });
    expect(result.reply).toMatch(/service address/i);
    expect(result.reply).not.toMatch(/leaks during use/i);
    expect(c.conversation.save).toHaveBeenCalled();
  });
  test('active evidence never downgrades emergency urgency', async () => {
    const c = context(channel); c.lead.urgency = 'emergency';
    await handleRecoveryIntake({ ...c, customerMessage: 'Water is actively leaking' });
    expect(c.lead.urgency).toBe('emergency');
    expect(stateOf(c).triageResolved).toBe(true);
  });
  test('a renewed leak reopens resolved triage', async () => {
    const c = context(channel, { triageResolved: true, triageAsked: true, triagePending: false });
    const result = await handleRecoveryIntake({ ...c, customerMessage: 'The pipe is leaking again' });
    expect(stateOf(c)).toMatchObject({ triageResolved: false, triagePending: true, triageAsked: true });
    expect(result.reply).toMatch(/right now/i);
    expect(result.intakeReady).toBe(false);
  });
  test.each(['yes', 'no'])('records a short triage answer: %s', async customerMessage => {
    const c = context(channel, { triagePending: true, triageAsked: true, field: 'leak_activity' });
    await handleRecoveryIntake({ ...c, customerMessage });
    expect(stateOf(c)).toMatchObject({ triageResolved: true, triagePending: false, triageAnswer: customerMessage, leakPattern: customerMessage === 'yes' ? 'active' : 'not_active' });
    expect(c.lead.urgency).toBe(customerMessage === 'yes' ? 'high' : 'medium');
  });
  test('a yes answer preserves existing emergency urgency', async () => {
    const c = context(channel, { triagePending: true, triageAsked: true, field: 'leak_activity' }); c.lead.urgency = 'emergency';
    await handleRecoveryIntake({ ...c, customerMessage: 'yes' });
    expect(c.lead.urgency).toBe('emergency');
    expect(stateOf(c).triagePending).toBe(false);
  });
  test('a negative constraint answer clears the question without escalating', async () => {
    const c = context(channel, { triagePending: true, triageAsked: true, field: 'constraint_condition', constraintQuestion: 'Is water spreading?' });
    await handleRecoveryIntake({ ...c, customerMessage: 'nope' });
    expect(stateOf(c)).toMatchObject({ constraintQuestion: '', triageAnswer: 'nope', leakPattern: 'not_active', triageResolved: true });
    expect(c.lead.urgency).toBe('medium');
  });
  test('an unrelated yes does not become a leak-activity answer', async () => {
    const c = context(channel, { triageResolved: true, triagePending: false, field: 'address' });
    await handleRecoveryIntake({ ...c, customerMessage: 'yes' });
    expect(stateOf(c).triageAnswer).toBeUndefined();
    expect(stateOf(c).leakPattern).toBeUndefined();
    expect(c.lead.urgency).toBe('medium');
  });
  test('during-use clarification is acknowledged and advances intake', async () => {
    const c = context(channel, { triagePending: true, triageAsked: true, field: 'leak_activity' });
    const result = await handleRecoveryIntake({ ...c, customerMessage: 'Only when I use it' });
    expect(stateOf(c)).toMatchObject({ triageResolved: true, leakPattern: 'during_use' });
    expect(result.reply).toMatch(/Thanks for clarifying.*service address/i);
    expect(c.lead.urgency).toBe('medium');
  });
  test('eligibility decisions return unchanged before intake side effects', async () => {
    const c = context(channel); const decision = { decision: 'send_fixed_response', reply: 'This service needs staff review.', intakeReady: false };
    guardServiceRequest.mockResolvedValue(decision);
    const semanticAssessment = { isInScope: true, confidence: 90 };
    expect(await handleRecoveryIntake({ ...c, customerMessage: 'pipe repair', semanticAssessment })).toBe(decision);
    expect(guardServiceRequest).toHaveBeenCalledWith(expect.objectContaining({ business: c.business, lead: c.lead, conversation: c.conversation, channel, turnId: c.turnId, semanticAssessment }));
    expect(classifySmsIntent).not.toHaveBeenCalled();
    expect(c.lead.save).not.toHaveBeenCalled();
    expect(getAvailability).not.toHaveBeenCalled();
    expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
  });
  test('eligibility failure does not continue to scheduling', async () => {
    const c = context(channel); guardServiceRequest.mockRejectedValue(new Error('eligibility unavailable'));
    await expect(handleRecoveryIntake({ ...c, customerMessage: 'pipe repair' })).rejects.toThrow('eligibility unavailable');
    expect(classifySmsIntent).not.toHaveBeenCalled();
    expect(c.lead.save).not.toHaveBeenCalled();
  });
  test('soft opt-out defers before eligibility and persistence', async () => {
    const c = context(channel);
    expect(await handleRecoveryIntake({ ...c, customerMessage: 'please stop texting me' })).toBeNull();
    expect(guardServiceRequest).not.toHaveBeenCalled();
    expect(c.conversation.save).not.toHaveBeenCalled();
  });
  test('availability receives the same business, lead, conversation and service', async () => {
    const c = context(channel, { triageResolved: true }); c.lead.address = '100 Main St Atlanta GA 30324';
    const result = await handleRecoveryIntake({ ...c, customerMessage: 'Sep 8 at 8 am' });
    expect(getAvailability).toHaveBeenCalledWith({ business: c.business, leadId: c.lead._id, conversationId: c.conversation._id, serviceQuery: 'pipe leak', serviceOfferingId: 'offering-coverage', startDate: '2026-09-08', endDate: '2026-09-08', postalCode: '30324' });
    expect(result.intakeReady).toBe(true);
  });
});
