jest.mock('../../src/models/serviceOffering.js', () => ({ __esModule: true, default: { find: jest.fn() } }));
import EligibilityCatalog from '../../src/models/serviceOffering.js';
import EligibilityOperations from '../../src/models/businessOperationsSettings.js';
import { approvedOffering, catalogQuery } from '../helpers/approvedServiceCatalog.js';
jest.mock('../../src/models/businessOperationsSettings.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
beforeEach(() => {
  EligibilityCatalog.find = jest.fn(() => catalogQuery([approvedOffering('s1', 'plumbing', ['dishwasher', 'appliance']), approvedOffering('hvac-1', 'hvac')]));
  EligibilityOperations.findOne.mockReturnValue(catalogQuery({ serviceEligibilityPolicy: { catalogComplete: true } }));
});
import { getApprovedServiceEstimate } from '../../src/services/booking/approvedServiceEstimate.service.js';
import { handleRecoveryIntake } from '../../src/services/booking/recoveryIntake.service.js';
import searchServices from '../../src/helpers/ai/tools/searchServices.tool.js';
import getAvailability from '../../src/helpers/ai/tools/getAvailability.tool.js';
import validateServiceArea from '../../src/helpers/ai/tools/validateServiceArea.tool.js';
import AlertService from '../../src/services/alert.service.js';
import { buildCompletedIntakeResult, shouldCompleteManualIntake, ensureHumanHandoffResult } from '../../src/services/messaging/smsHandoff.service.js';
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
beforeEach(() => { jest.clearAllMocks(); getApprovedServiceEstimate.mockResolvedValue(''); validateServiceArea.mockResolvedValue({ supported: true }); searchServices.mockResolvedValue([{ id: 's1', score: 1 }]); getAvailability.mockResolvedValue({ supportedServiceArea: true, slots: [slot] }); AlertService.createHumanHandoffAlert.mockResolvedValue({ alert: { _id: 'a1' } }); });
test.each(['sms', 'voice'])('%s captures the toilet transcript without reasking a supplied time', async channel => {
  const c = context(channel);
  expect((await c.turn('Hi my toilet is stopped up and leaking around the seal')).reply).toMatch(/right now/);
  expect((await c.turn('Only when the toilet is used')).reply).toMatch(/service address/);
  await c.turn('Sep 8'); await c.turn('8 am');
  expect(c.lead.preferredAppointmentTime).toBe('2026-09-08 at 8:00 AM');
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
 expect(result.intakeReady).toBe(true); expect(c.lead.preferredAppointmentTime).toBe('2026-09-08 at 8:00 AM');
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
 expect(result.reply).toMatch(/Which appliance/);
 expect(result.intakeReady).toBe(false);
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
 expect(reply).toContain('Wed, Sep 9 at 8:00 AM');
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
 expect(result.intakeReview.availability.status).toBe('not_checked');
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

test.each(['sms','voice'])('%s keeps a same-day request actionable when no slot is available', async channel => {
 const c=context(channel); c.now=new Date('2026-09-06T14:00:00Z');
 c.lead.serviceNeeded='HVAC repair'; c.lead.address='970 Sidney Marcus Blvd NE Atlanta GA 30324';
 getAvailability.mockResolvedValue({supportedServiceArea:true,slots:[]});
 const result=await c.turn('Today at 3 pm');
 expect(result.handoff).toMatchObject({required:true,reason:'scheduling_review'});
 expect(result.reply).toMatch(/not a confirmed appointment/);
 expect(result.intakeReady).toBe(false);
 if(channel==='voice') expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledTimes(1);
});

test.each(['sms', 'voice'])('%s preserves the sink through compound price/time and checks the late time', async channel => {
  const c = context(channel);
  await c.turn('My kitchen sink is clogged and the water backs up into the other side when I run the disposal');
  await c.turn('No other fixtures are affected. Only the sink.');
  await c.turn('979 Walk Rd Atlanta GA 30324');
  getApprovedServiceEstimate.mockResolvedValue('The approved estimate is $150–$300; final price requires inspection.');
  const r = await c.turn('Sep 8 at 9pm. How much would it cost to fix something like this?');
  expect(c.lead.serviceNeeded).toMatch(/sink/i);
  expect(c.lead.serviceNeeded).not.toMatch(/fix something/);
  expect(c.lead.address).toBe('979 Walk Rd Atlanta GA 30324');
  expect(c.lead.preferredAppointmentTime).toBe('2026-09-08 at 9:00 PM');
  expect(r.reply).toMatch(/150/);
  expect(r.reply).toMatch(/isn't available/);
  expect(r.intakeReady).toBe(false);
  expect(getAvailability).toHaveBeenCalled();
});
test('suppressed clog question remains pending and is asked again before address', async () => {
  const c = context();
  const first = await c.turn('My kitchen sink is clogged');
  expect(first.reply).toMatch(/overflowing/);
  const r = await handleRecoveryIntake({ ...c, customerMessage: 'My kitchen sink is clogged', recentMessages: [
    { direction: 'outbound', body: first.reply, status: 'suppressed', deliveryStatus: 'suppressed' }
  ] });
  expect(r.reply).toMatch(/overflowing/);
  expect(r.intakeReady).toBe(false);
});

test('voice model wording cannot replace the service detail during a contextual price question', async () => {
  const c = context('voice');
  await c.turn('My kitchen sink is clogged'); await c.turn('No other fixtures are affected');
  await handleRecoveryIntake({ ...c, customerMessage: 'How much to fix something like this?', semanticAssessment: {
    isInScope: true, confidence: 95, serviceNeeded: 'fix something like this', decision: 'send_fixed_response'
  } });
  expect(c.lead.serviceNeeded).toMatch(/sink/);
  expect(c.conversation.conversationMemory.recoveryIntake.serviceDetail).toMatch(/sink/);
});

test.each(['sms', 'voice'])('%s clarifies a vague problem, keeps out-of-order facts, and blocks out-of-area dates early', async channel => {
 const c = context(channel);
 const first = await c.turn('My toilet is broken');
 expect(first.intakeReady).toBe(false);
 expect(c.conversation.conversationMemory.recoveryIntake.problem.status).toBe('needs_clarification');
 expect(first.reply).toMatch(/what is happening/i);
 await c.turn('Tuesday at 1 pm');
 expect(c.lead.preferredAppointmentTime).toBeTruthy();
 expect(c.conversation.conversationMemory.recoveryIntake.problem.status).toBe('needs_clarification');
 const detail = await c.turn("It won't flush");
 expect(detail.reply).toMatch(/service address/);
 expect(c.conversation.conversationMemory.recoveryIntake.problem.status).toBe('clear');
 validateServiceArea.mockResolvedValue({ supported: false, reason: 'outside_configured_service_area' });
 const outside = await c.turn('123 Easy Street Bessemer AL 35022');
 expect(outside.reply).toMatch(/outside the configured service area/);
 expect(outside.intakeReady).toBe(false);
 expect(getAvailability).not.toHaveBeenCalled();
 expect(c.conversation.conversationMemory.recoveryIntake.readiness.readyForOptions).toBe(false);
});
test.each(['sms', 'voice'])('%s routes unknown coverage to review with an explicitly tentative preference and no calendar lookup', async channel => {
 const c = context(channel); await c.turn('Replace my faucet');
 validateServiceArea.mockResolvedValue({ supported: null, reason: 'service_area_not_configured' });
 const result = await c.turn('123 Easy Street Bessemer AL 35022');
 expect(result.intakeReady).toBe(false);
 expect(result.handoff.required).toBe(true);
 expect(result.reply).toMatch(/preference for review/i);
 expect(result.reply).not.toMatch(/currently available/i);
 expect(result.intakeReview.coverage.supported).toBeNull();
 expect(getAvailability).not.toHaveBeenCalled();
 if (channel === 'voice') expect(AlertService.createHumanHandoffAlert).toHaveBeenCalled();
});
test.each(['sms', 'voice'])('%s records uncertain customer details for review without a false completed intake', async channel => {
 const c = context(channel); await c.turn('My toilet is broken');
 const result = await c.turn("I don't know");
 expect(result.intakeReady).toBe(false);
 expect(result.handoff.required).toBe(true);
 expect(c.conversation.conversationMemory.recoveryIntake.problem.status).toBe('needs_staff_review');
 expect(getAvailability).not.toHaveBeenCalled();
});
test('voice qualification review cannot acknowledge a failed durable alert', async () => {
 const c = context('voice'); await c.turn('My toilet is broken');
 AlertService.createHumanHandoffAlert.mockRejectedValue(new Error('storage failed'));
 await expect(c.turn("I don't know")).rejects.toThrow('storage failed');
 expect(c.conversation.conversationMemory.recoveryIntake.submitted).not.toBe(true);
});
test('missing explicit readiness never completes manual intake', () => {
 const c = context(); Object.assign(c.lead, { serviceNeeded: 'toilet repair', address: '123 Easy Street 35022', preferredAppointmentTime: 'Tuesday at 1', urgency: 'medium' });
 expect(shouldCompleteManualIntake({ ...c, result: { messageCategory: 'service_request' } })).toBe(false);
});


test('SMS handoff preserves the coverage blocker instead of claiming an unsolicited callback request', async () => {
 const c = context(); await c.turn('Replace my faucet');
 validateServiceArea.mockResolvedValue({ supported: null, reason: 'service_area_not_configured' });
 const result = await c.turn('123 Easy Street Bessemer AL 35022');
 const final = ensureHumanHandoffResult({ ...c, result, customerMessage: '123 Easy Street Bessemer AL 35022' });
 expect(final.reply).toMatch(/coverage.*review/i);
 expect(final.reply).not.toMatch(/callback request|currently available/i);
 expect(final.handoff.required).toBe(true);
});

// Exercise the actual intake and final outbound guard together across turns.
import { applySmsProductionInvariants } from '../../src/services/messaging/smsProductionInvariant.service.js';
const finalReply = (ctx, result, customerMessage) => applySmsProductionInvariants({ ...ctx, result, customerMessage, now: ctx.now });
test('unavailable Sunday then ambiguous Monday question retains one current preference and one coherent response', async () => {
 const c = context(); c.now = new Date('2026-09-19T22:49:00Z');
 c.turn = customerMessage => handleRecoveryIntake({ ...c, customerMessage });
 await c.turn('Hi I need a bathtub installed');
 await c.turn('6564 piedmont road Atlanta ga 30324');
 getAvailability.mockResolvedValue({ supportedServiceArea: true, slots: [] });
 const sunday = finalReply(c, await c.turn('Tomorrow at 3:00pm'), 'Tomorrow at 3:00pm');
 expect(sunday.reply).toMatch(/no eligible openings/);
 expect(sunday.reply).toMatch(/later day/);
 expect(sunday.reply).not.toMatch(/still needs to be checked|preferred time|currently available/);
 expect(c.conversation.conversationMemory.recoveryIntake.availability.status).toBe('no_matching_slot');
 const message = 'Monday at 3:00pm. How much is the estimated job completion?';
 const monday = finalReply(c, await c.turn(message), message);
 expect(monday.reply).toMatch(/Do you mean how long/);
 expect(monday.reply).not.toMatch(/confirmed price|saved for team review|currently available/);
 expect(c.lead.preferredAppointmentTime).toBe('2026-09-21 at 3:00 PM');
 const state = c.conversation.conversationMemory.recoveryIntake;
 expect(state.activePreference.label).toBe(c.lead.preferredAppointmentTime);
 expect(state.availability.status).toBe('not_checked');
 expect(state.unresolvedQuestions.map(q => q.kind)).toEqual(['completion_meaning']);
 expect(state.reviewReady).toBe(false);
 expect(c.lead.serviceNeeded).not.toMatch(/^Hi|^I need/);
 expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
 const duration = finalReply(c, await c.turn('I mean how long'), 'I mean how long');
 expect(duration.reply).toMatch(/assess the job scope/);
 expect(c.conversation.conversationMemory.recoveryIntake.unresolvedQuestions.map(q => q.kind)).toEqual(['duration']);
 expect(c.lead.preferredAppointmentTime).toBe('2026-09-21 at 3:00 PM');
});
test('provider outage and an unchecked service match remain different states through final guard', async () => {
 const c=context(); c.lead.serviceNeeded='toilet repair'; c.lead.address='970 Sidney Marcus Blvd NE Atlanta GA 30324';
 getAvailability.mockRejectedValue(new Error('provider unavailable'));
 const r=finalReply(c, await c.turn('Sep 8 at 8 am'), 'Sep 8 at 8 am');
 expect(r.reply).toMatch(/couldn't verify/); expect(r.reply).not.toMatch(/no eligible openings|currently available/);
 expect(c.conversation.conversationMemory.recoveryIntake.availability.status).toBe('check_failed');
});
test('revised preference plus question after handoff invalidates availability and queues current facts', async () => {
 const c=context(); c.lead.serviceNeeded='toilet installation'; c.lead.address='970 Sidney Marcus Blvd NE Atlanta GA 30324';
 await c.turn('Sep 8 at 8 am');
 c.conversation.orchestration = { handoffReason: 'intake_complete' };
 AlertService.create = jest.fn().mockResolvedValue({ alert: { _id: 'review2' } });
 const r=await handleRecoveryIntake({ ...c, reviewOnly: true, turnId:'revision', customerMessage:'Sep 9 at 10 am. What is the estimated completion?' });
 expect(r.reply).toMatch(/Do you mean/);
 expect(c.lead.preferredAppointmentTime).toBe('2026-09-09 at 10:00 AM');
 expect(c.conversation.conversationMemory.recoveryIntake.review.status).toBe('queued');
 expect(c.conversation.conversationMemory.recoveryIntake.availability.status).toBe('not_checked');
 expect(AlertService.create).toHaveBeenCalledWith(expect.objectContaining({ actionRequired: true, metadata: expect.objectContaining({ intakeReview: expect.objectContaining({ preferredAppointmentTime: '2026-09-09 at 10:00 AM' }) }) }));
 AlertService.create.mockRejectedValue(new Error('write failed'));
 await expect(handleRecoveryIntake({ ...c, reviewOnly:true, customerMessage:'Sep 10 at 11 am. Estimated completion?' })).rejects.toThrow('write failed');
});
test('failed persistence prevents a prepared completion from escaping', async () => {
 const c=context(); c.lead.serviceNeeded='toilet repair'; c.lead.address='970 Sidney Marcus Blvd NE Atlanta GA 30324';
 c.lead.save.mockRejectedValue(new Error('lead write failed'));
 await expect(c.turn('Sep 8 at 8 am')).rejects.toThrow('lead write failed');
 expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
});

test.each(['sms', 'voice'])('%s corrected service stays authoritative through triage, date collection, availability and final summary', async channel => {
  const c = context(channel); c.now = new Date('2026-09-21T22:00:00Z');
  c.turn = customerMessage => handleRecoveryIntake({ ...c, customerMessage });
  getAvailability.mockResolvedValue({ supportedServiceArea: true, slots: [{ startAt: '2026-09-22T15:00:00-04:00', endAt: '2026-09-22T16:00:00-04:00' }] });
  await c.turn('Washing machine is leaking from the wall');
  // Previously answered appliance triage must not answer the new pipe question.
  await c.turn('Only when I use it');
  const corrected = await c.turn("It's actually a pipe in the wall that is leaking");
  expect(corrected.reply).toMatch(/pipe leaking right now/i);
  expect(c.conversation.conversationMemory.recoveryIntake.triagePending).toBe(true);
  await c.turn('Only when I use it');
  await c.turn('979 Bob Ross Atlanta, Ga 30324');
  const result = await c.turn('Tomorrow at 3:00pm');
  expect(result.intakeReady).toBe(true);
  expect(result.serviceNeeded).toBe('pipe in the wall that is leaking');
  expect(result.intakeReview.serviceDetail).toBe(result.serviceNeeded);
  expect(result.summary).not.toMatch(/washing machine|actually/i);
  const reply = channel === 'voice' ? result.reply : buildCompletedIntakeResult({ business, result }).reply;
  expect(reply).toMatch(/pipe in the wall/);
  expect(reply).not.toMatch(/washing machine|actually/i);
  expect(reply).toContain('leaks during use');
  expect(reply).toContain('Tue, Sep 22 at 3:00 PM');
  expect(reply).toContain('not confirmed');
  expect(getAvailability).toHaveBeenCalledWith(expect.objectContaining({ serviceQuery: 'pipe in the wall that is leaking' }));
  if (channel === 'sms') expect(reply.length).toBeLessThanOrEqual(320);
  else expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ serviceNeeded: result.serviceNeeded, summary: expect.not.stringMatching(/washing machine/i) }) }));
});

// Rejected dates are never queried or persisted as accepted preferences.
test.each(['sms', 'voice'])('%s applies accepted scheduling corrections across turns', async channel => {
 const c=context(channel); c.now=new Date('2026-09-23T14:00:00Z');
 c.lead.serviceNeeded='faucet replacement'; c.lead.address='970 Sidney Marcus Blvd NE Atlanta GA 30324';
 getAvailability.mockResolvedValue({supportedServiceArea:true,slots:[]});
 await c.turn("I can't do Monday. Friday at 10 am works");
 expect(c.lead.preferredAppointmentTime).toBe('2026-09-25 at 10:00 AM');
 expect(getAvailability).toHaveBeenLastCalledWith(expect.objectContaining({startDate:'2026-09-25',endDate:'2026-09-25'}));
 getAvailability.mockClear();
 const rejected=await c.turn("Friday doesn't work");
 expect(rejected.reply).toMatch(/what day would work instead/i);
 expect(rejected.intakeReady).toBe(false);
 expect(getAvailability).not.toHaveBeenCalled();
 expect(c.lead.preferredAppointmentTime).not.toContain('2026-09-25');
 await c.turn('Next Tuesday at 11 am');
 expect(c.lead.preferredAppointmentTime).toBe('2026-09-29 at 11:00 AM');
});

test.each(['sms', 'voice'])('%s clears rejected transient offers in review-only intake', async channel => {
 const c=context(channel); c.now=new Date('2026-09-23T14:00:00Z');
 c.lead.serviceNeeded='faucet replacement'; c.lead.address='970 Sidney Marcus Blvd NE Atlanta GA 30324';
 c.lead.preferredAppointmentTime='2026-09-25 at 10:00 AM';
 c.conversation.bookingState={status:'offering_slots',offeredSlots:[slot],selectedSlot:slot};
 AlertService.create=jest.fn().mockResolvedValue({alert:{_id:'review-alert'}});
 await handleRecoveryIntake({...c,customerMessage:"Friday doesn't work",reviewOnly:true});
 expect(c.conversation.bookingState.offeredSlots).toEqual([]);
 expect(c.conversation.bookingState.selectedSlot).toBeNull();
 expect(c.lead.preferredAppointmentTime).not.toContain('2026-09-25');
 expect(getAvailability).not.toHaveBeenCalled();
});

test.each(['sms', 'voice'])('%s confirmation follow-up preserves facts and does not repeat scheduling or alert creation', async channel => {
 const c=context(channel); c.lead.serviceNeeded='toilet repair'; c.lead.address='123 Lenox Rd Atlanta GA 30324';
 c.lead.preferredAppointmentTime='2026-10-02 at 12:00 PM';
 c.conversation.conversationMemory.recoveryIntake={review:{status:'queued',alertId:'a1'}};
 const before=JSON.stringify(c.lead);
 const result=await c.turn('How long will it take for appointment confirmation?');
 expect(result.reply).toContain('Fri, Oct 2 at 12:00 PM');
 expect(result.reply).toContain('call me'); expect(result.shouldAlertOwner).toBe(false);
 expect(c.lead).toMatchObject(JSON.parse(before));
 expect(getAvailability).not.toHaveBeenCalled();expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
});
test('voice cannot claim review is queued when the alert result lacks a durable ID', async () => {
 const c=context('voice');c.lead.serviceNeeded='toilet repair';c.lead.address='123 Lenox Rd Atlanta GA 30324';
 AlertService.createHumanHandoffAlert.mockResolvedValueOnce({});
 await expect(c.turn('Sep 8 at 8 am')).rejects.toMatchObject({code:'STAFF_ACTION_NOT_SAVED'});
 expect(c.conversation.conversationMemory.recoveryIntake.review.status).toBe('pending_persistence');
 expect(c.conversation.conversationMemory.recoveryIntake.submitted).not.toBe(true);
});
