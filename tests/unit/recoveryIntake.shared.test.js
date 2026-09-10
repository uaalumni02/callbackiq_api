import { getApprovedServiceEstimate } from '../../src/services/booking/approvedServiceEstimate.service.js';
import { handleRecoveryIntake } from '../../src/services/booking/recoveryIntake.service.js';
import searchServices from '../../src/helpers/ai/tools/searchServices.tool.js';
import getAvailability from '../../src/helpers/ai/tools/getAvailability.tool.js';
import validateServiceArea from '../../src/helpers/ai/tools/validateServiceArea.tool.js';
import AlertService from '../../src/services/alert.service.js';
import { buildCompletedIntakeResult, shouldCompleteManualIntake } from '../../src/services/messaging/smsHandoff.service.js';
import { sanitizeUnverifiedStaffCommitments } from '../../src/services/customerCommitmentSafety.service.js';
jest.mock('../../src/services/booking/approvedServiceEstimate.service.js', () => ({ getApprovedServiceEstimate: jest.fn().mockResolvedValue('') }));
jest.mock('../../src/helpers/ai/tools/searchServices.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/getAvailability.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/validateServiceArea.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { createHumanHandoffAlert: jest.fn() } }));
const now = new Date('2026-09-06T01:24:00Z');
const business = { _id: 'b1', businessName: 'Atlanta Pro Plumbing & Drain', timezone: 'America/New_York', features: { aiBookingEnabled: false } };
const slot = { startAt: '2026-09-08T08:00:00-04:00', endAt: '2026-09-08T09:00:00-04:00' };
function context(channel = 'sms') {
  const lead = { _id: 'l1', serviceNeeded: 'Unknown', urgency: 'medium', phone: '+14045550100', save: jest.fn().mockResolvedValue(null) };
  const conversation = { _id: 'c1', status: 'open', bookingState: { status: 'not_started' }, conversationMemory: {}, save: jest.fn().mockResolvedValue(null), set(path, value) { this.conversationMemory.recoveryIntake = value; } };
  const ctx = { business, lead, conversation, channel, session: { _id: 'v1' }, now };
  ctx.turn = customerMessage => handleRecoveryIntake({ ...ctx, customerMessage });
  return ctx;
}
beforeEach(() => { jest.clearAllMocks(); getApprovedServiceEstimate.mockResolvedValue(''); validateServiceArea.mockResolvedValue({ supported: true }); searchServices.mockResolvedValue([{ id: 's1', score: 1 }]); getAvailability.mockResolvedValue({ supportedServiceArea: true, slots: [slot] }); AlertService.createHumanHandoffAlert.mockResolvedValue({ _id: 'a1' }); });
test.each(['sms', 'voice'])('%s captures the toilet transcript without reasking a supplied time', async channel => {
  const c = context(channel);
  expect((await c.turn('Hi my toilet is stopped up and leaking around the seal')).reply).toMatch(/right now/);
  expect((await c.turn('Only when the toilet is used')).reply).toMatch(/service address/);
  await c.turn('Sep 8'); await c.turn('8 am');
  expect(c.lead.preferredAppointmentTime).toBe('2026-09-08 at 8:00');
  expect((await c.turn('When will it be confirmed')).reply).toMatch(/don't have a confirmation timeframe/);
  const result = await c.turn('My address is 970 Sidney Marcus blvd ne Atlanta , ga 30324');
  expect(result.reply).not.toMatch(/preferred.*still|what.*time|pause automated/i);
  expect(result.intakeReady).toBe(true);
  expect(result.reply).toMatch(/currently available/);
  expect(getAvailability).toHaveBeenCalledWith(expect.objectContaining({ postalCode: '30324', startDate: '2026-09-08', endDate: '2026-09-08' }));
  if (channel === 'voice') { expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledTimes(1); expect(result.reply).toMatch(/not confirmed/); }
  else expect(buildCompletedIntakeResult({ business, result }).reply).toMatch(/saved for team review/);
});
test('voice facts remain available when SMS supplies the address', async () => {
 const c = context('voice'); await c.turn('My toilet is clogged and leaking'); await c.turn('No'); await c.turn('Sep 8 at 8 am');
 const result = await handleRecoveryIntake({ ...c, channel: 'sms', customerMessage: '970 Sidney Marcus Blvd NE, Atlanta GA 30324' });
 expect(result.intakeReady).toBe(true); expect(c.lead.preferredAppointmentTime).toBe('2026-09-08 at 8:00');
});
test('an address or date cannot answer an unresolved leak question', async () => {
 const c = context(); await c.turn('My toilet is leaking'); await c.turn('Sep 8'); await c.turn('8 am');
 const r = await c.turn('970 Sidney Marcus Blvd NE Atlanta GA 30324');
 expect(r.intakeReady).toBe(false); expect(r.reply).toMatch(/leaking right now/); expect(getAvailability).not.toHaveBeenCalled();
});
test.each(['sms','voice'])('%s blocks an unavailable requested time and offers alternatives', async channel => {
 const c=context(channel); c.lead.serviceNeeded='toilet repair'; c.lead.address='970 Sidney Marcus Blvd NE Atlanta GA 30324';
 getAvailability.mockResolvedValue({supportedServiceArea:true,slots:[{...slot,startAt:'2026-09-08T10:00:00-04:00',endAt:'2026-09-08T11:00:00-04:00'}]});
 const r=await c.turn('Sep 8 at 8 am'); expect(r.intakeReady).toBe(false); expect(r.reply).toMatch(/10:00/); expect(r.reply).toMatch(/isn't available/); expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
});
test('provider failure remains unknown and can be queued for manual review', async () => {
 const c=context(); c.lead.serviceNeeded='toilet repair'; c.lead.address='970 Sidney Marcus Blvd NE Atlanta GA 30324'; getAvailability.mockRejectedValue(new Error('503'));
 const r=await c.turn('Sep 8 at 8 am'); expect(r.intakeReady).toBe(true); expect(r.reply).toMatch(/couldn't verify/); expect(r.reply).not.toMatch(/no available openings/);
});
test('voice never acknowledges a handoff if the strict alert write fails', async () => {
 const c=context('voice'); c.lead.serviceNeeded='toilet repair'; c.lead.address='970 Sidney Marcus Blvd NE Atlanta GA 30324'; AlertService.createHumanHandoffAlert.mockRejectedValueOnce(new Error('database unavailable'));
 await expect(c.turn('Sep 8 at 8 am')).rejects.toThrow('database unavailable'); expect(c.conversation.conversationMemory.recoveryIntake.submitted).not.toBe(true);
 const result=await c.turn('Sep 8 at 8 am'); expect(result.reply).toMatch(/saved for team review/);
 expect(c.lead.save.mock.invocationCallOrder[0]).toBeLessThan(AlertService.createHumanHandoffAlert.mock.invocationCallOrder[0]);
});
test('out of area does not become a ready appointment request', async () => {
 const c=context(); c.lead.serviceNeeded='toilet repair'; c.lead.address='970 Sidney Marcus Blvd NE Atlanta GA 30324'; validateServiceArea.mockResolvedValue({supported:false});
 const r=await c.turn('Sep 8 at 8 am'); expect(r.intakeReady).toBe(false); expect(getAvailability).not.toHaveBeenCalled(); expect(shouldCompleteManualIntake({...c,result:r})).toBe(false);
});
test.each(["We'll confirm availability soon.","Our team will review and confirm the appointment as soon as possible.","We’ll confirm it soon."] )('shared output guard removes unsupported promise: %s', reply => {
 const safe=sanitizeUnverifiedStaffCommitments(reply); expect(safe).not.toMatch(/soon|as soon as possible/); expect(safe).not.toMatch(/flagged|sent|submitted/);
});
test.each(['sms','voice'])('%s defers unfamiliar answers and off-script questions to semantic understanding', async channel => {
 const c=context(channel); await c.turn('My toilet is clogged');
 for (const text of ['purple elephants', 'the moon tastes blue', 'Is that work covered under warranty?']) {
   expect(await c.turn(text)).toBeNull();
 }
 expect(c.conversation.conversationMemory.recoveryIntake.failures).toBe(0);
});

test.each(['sms', 'voice'])('%s understands the exact bathtub sequence without losing pricing or service context', async channel => {
 const c = context(channel);
 const first = await c.turn('My bathtub needs resealing. How much is the cost');
 expect(c.lead.serviceNeeded).toMatch(/bathtub.*resealing/i);
 expect(first.reply).toMatch(/price/i);
 expect(first.reply).not.toMatch(/what service|didn.t understand/i);
 for (const text of ['Bathtub needs resealing', 'Seal around tube needs to be replaced']) {
   const result = await c.turn(text);
   expect(result.reply).not.toMatch(/what service|didn.t understand|response timeframe|saved for team review/i);
   expect(result.handoff).toBeUndefined();
 }
 const leak = await c.turn('Bathtub is leaking');
 expect(leak.reply).toMatch(/leaking.*right now/i);
 expect(c.conversation.conversationMemory.recoveryIntake.serviceDetail).toMatch(/bathtub.*leaking/i);
 expect(c.lead.urgency).not.toBe('emergency');
});

test.each(['sms', 'voice'])('%s accepts new understood facts after an unclear handoff', async channel => {
 const c = context(channel);
 await c.turn('My toilet is clogged');
 c.conversation.conversationMemory.recoveryIntake = { ...c.conversation.conversationMemory.recoveryIntake, submitted: channel === 'voice', failures: 2 };
 c.conversation.orchestration = { handoffReason: 'intake_unclear' };
 const reply = await c.turn('My bathtub needs resealing');
 expect(reply.handoff).toBeUndefined();
 expect(reply.reply).not.toMatch(/response timeframe/);
 expect(c.conversation.conversationMemory.recoveryIntake.serviceDetail).toMatch(/resealing/);
});

test('a semantic service can start shared intake without a deterministic keyword match', async () => {
 const c = context();
 const result = await handleRecoveryIntake({ ...c, customerMessage: 'The little whirly thing just gives a sad hum', semanticAssessment: { confidence: 88, isInScope: true, serviceNeeded: 'appliance making a humming sound' } });
 expect(c.lead.serviceNeeded).toBe('appliance making a humming sound');
 expect(result.reply).toMatch(/service address/);
});

test('low-confidence semantic guesses cannot populate intake', async () => {
 const c = context();
 const result = await handleRecoveryIntake({ ...c, customerMessage: 'purple elephants', semanticAssessment: { confidence: 30, isInScope: true, serviceNeeded: 'gas leak' } });
 expect(result).toBeNull(); expect(c.lead.serviceNeeded).toBe('Unknown');
});

test('clear service phrased as help is captured', async () => {
 const c = context();
 const result = await c.turn('I need help with resealing my bathtub');
 expect(result.reply).toMatch(/service address/);
 expect(c.lead.serviceNeeded).toMatch(/resealing/);
});

test.each(['not overflowing', 'no longer overflowing', 'stopped overflowing'])('negated overflow does not become high urgency: %s', async text => {
 const c = context(); await c.turn('My bathtub is leaking');
 await c.turn(text);
 expect(c.lead.urgency).toBe('medium');
 expect(c.conversation.conversationMemory.recoveryIntake.triagePending).toBe(false);
});

test('pricing does not repeat resolved leak triage', async () => {
 const c = context(); await c.turn('My bathtub is leaking'); await c.turn('Only when used');
 const reply = await c.turn('How much is the cost?');
 expect(reply.reply).toMatch(/price/); expect(reply.reply).toMatch(/service address/);
 expect(reply.reply).not.toMatch(/leaking.*right now|active leak/);
});

test.each(['I need help', 'I need a pizza'])('vague or unsupported noun-only requests reach semantic understanding: %s', async text => {
 const c = context();
 expect(await c.turn(text)).toBeNull();
 expect(c.lead.serviceNeeded).toBe('Unknown');
 expect(c.lead.save).not.toHaveBeenCalled();
});

test.each(['sms','voice'])('%s discloses an approved estimate with scope and keeps intake moving', async channel => {
 const c = context(channel);
 getApprovedServiceEstimate.mockResolvedValue('The published rough estimate is $150–$250. Final pricing depends on scope and technician evaluation.');
 const result = await c.turn('My bathtub needs resealing. How much is the cost');
 expect(result.reply).toContain('$150–$250');
 expect(result.reply).toMatch(/scope/);
 expect(result.reply).not.toMatch(/don.t have a confirmed price/);
 expect(getApprovedServiceEstimate).toHaveBeenCalledWith(expect.objectContaining({businessId:'b1',serviceNeeded:expect.stringMatching(/bathtub/)}));
});

test('price lookup failure cannot invent a price or lose service facts', async () => {
 const c=context(); getApprovedServiceEstimate.mockRejectedValue(new Error('unavailable'));
 const result=await c.turn('My bathtub needs resealing. How much is the cost');
 expect(result.reply).toMatch(/don.t have a confirmed price/);
 expect(c.lead.serviceNeeded).toMatch(/resealing/);
});

test.each(['sms', 'voice'])('%s preserves the reported bathtub request in a truthful completion summary', async channel => {
 const c = context(channel);
 getAvailability.mockResolvedValue({ slots: [{ startAt: '2026-09-09T08:00:00-04:00', endAt: '2026-09-09T09:00:00-04:00' }] });
 expect((await c.turn('Seal around my bathtub is leaking')).reply).toContain('bathtub leaking right now');
 expect((await c.turn('Only when fixture is used')).reply).toMatch(/address/);
 expect((await c.turn('970 Sidney Marcus Blvd NE Atlanta GA 30324')).reply).toMatch(/business will need to approve/);
 await c.turn('Wed Sep 9');
 const result = await c.turn('8 am');
 const reply = channel === 'voice' ? result.reply : buildCompletedIntakeResult({ business, result }).reply;
 expect(reply).toContain('970 Sidney Marcus Blvd NE Atlanta GA 30324');
 expect(reply).toContain('Wed, Sep 9 at 8 AM');
 expect(reply).toMatch(/bathtub/);
 expect(reply).toContain('leaks during use');
 expect(reply).toContain('not confirmed');
 expect(reply).toContain('wait for confirmation');
 expect(reply).not.toMatch(/confirmation text|shortly|right away/);
 expect(result.intakeReview.triageAnswer).toBe('Only when fixture is used');
 expect(result.intakeReview.availability.serviceOfferingId).toBe('s1');
 if (channel === 'sms') expect(reply.length).toBeLessThanOrEqual(320);
 else expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({ providerMessageId: expect.stringMatching(/^voice-intake:/), result: expect.objectContaining({ handoff: { reason: 'intake_complete' } }) }));
});

test.each(['sms', 'voice'])('%s never calls an unrelated sole service available', async channel => {
 const c = context(channel); c.lead.serviceNeeded = 'bathtub resealing'; c.lead.address = '87 Oak Lane Marietta GA 30060';
 searchServices.mockResolvedValue([{ id: 'unrelated-service', score: 0 }]);
 const result = await c.turn('Sep 8 at 8 am');
 expect(getAvailability).not.toHaveBeenCalled();
 expect(result.intakeReview.availability.status).toBe('unknown');
 const reply = channel === 'voice' ? result.reply : buildCompletedIntakeResult({ business, result }).reply;
 expect(reply).toContain('87 Oak Lane');
 expect(reply).not.toContain('123 Main');
 expect(reply).not.toMatch(/currently available|booked/);
});

test.each(['sms', 'voice'])('%s keeps the original service detail when semantic triage repeats a generic service', async channel => {
 const c = context(channel); await c.turn('Seal around my bathtub is leaking');
 await handleRecoveryIntake({ ...c, customerMessage: 'Only when fixture is used', semanticAssessment: { isInScope: true, confidence: 90, serviceNeeded: 'plumbing service' } });
 expect(c.conversation.conversationMemory.recoveryIntake.serviceDetail).toBe('Seal around my bathtub is leaking');
 expect(c.conversation.conversationMemory.recoveryIntake.triageAnswer).toBe('Only when fixture is used');
});

 test.each(['sms', 'voice'])('%s answers approved pricing after submitted intake without promising a booking', async channel => {
 const c=context(channel); c.lead.serviceNeeded='AC repair'; c.lead.address='970 Sidney Marcus Blvd NE Atlanta GA 30324';
 await c.turn('Sep 8 at 8 am');
 c.conversation.conversationMemory.recoveryIntake.submitted=true;
 getApprovedServiceEstimate.mockResolvedValue('The rough estimate is $125-$250. Final pricing depends on technician evaluation.');
 const result=await c.turn('How much will it cost?');
 expect(result.reply).toContain('$125-$250');
 expect(result.reply).not.toMatch(/appointment is confirmed|will call/);
 expect(c.conversation.bookingState.status).toBe('not_started');
 });
