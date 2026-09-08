import { handleRecoveryIntake } from '../../src/services/booking/recoveryIntake.service.js';
import searchServices from '../../src/helpers/ai/tools/searchServices.tool.js';
import getAvailability from '../../src/helpers/ai/tools/getAvailability.tool.js';
import validateServiceArea from '../../src/helpers/ai/tools/validateServiceArea.tool.js';
import AlertService from '../../src/services/alert.service.js';
import { buildCompletedIntakeResult, shouldCompleteManualIntake } from '../../src/services/messaging/smsHandoff.service.js';
import { sanitizeUnverifiedStaffCommitments } from '../../src/services/customerCommitmentSafety.service.js';
jest.mock('../../src/helpers/ai/tools/searchServices.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/getAvailability.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/validateServiceArea.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { createHumanHandoffAlert: jest.fn() } }));
const now = new Date('2026-09-08T01:24:00Z');
const business = { _id: 'b1', businessName: 'Atlanta Pro Plumbing & Drain', timezone: 'America/New_York', features: { aiBookingEnabled: false } };
const slot = { startAt: '2026-09-08T08:00:00-04:00', endAt: '2026-09-08T09:00:00-04:00' };
function context(channel = 'sms') {
  const lead = { _id: 'l1', serviceNeeded: 'Unknown', urgency: 'medium', phone: '+14045550100', save: jest.fn().mockResolvedValue(null) };
  const conversation = { _id: 'c1', status: 'open', bookingState: { status: 'not_started' }, conversationMemory: {}, save: jest.fn().mockResolvedValue(null), set(path, value) { this.conversationMemory.recoveryIntake = value; } };
  const ctx = { business, lead, conversation, channel, session: { _id: 'v1' }, now };
  ctx.turn = customerMessage => handleRecoveryIntake({ ...ctx, customerMessage });
  return ctx;
}
beforeEach(() => { jest.clearAllMocks(); validateServiceArea.mockResolvedValue({ supported: true }); searchServices.mockResolvedValue([{ id: 's1' }]); getAvailability.mockResolvedValue({ supportedServiceArea: true, slots: [slot] }); AlertService.createHumanHandoffAlert.mockResolvedValue({ _id: 'a1' }); });
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
 getAvailability.mockResolvedValue({supportedServiceArea:true,slots:[{...slot,startAt:'2026-09-08T10:00:00-04:00'}]});
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
test.each(['sms','voice'])('%s stops asking the same field after two unusable answers', async channel => {
 const c=context(channel); await c.turn('My toilet is clogged');
 expect((await c.turn('purple elephants')).handoff).toBeUndefined();
 const result=await c.turn('the moon tastes blue'); expect(result.handoff.reason).toBe('intake_unclear');
 expect(result.reply).not.toMatch(/service address\?/); if(channel==='voice') expect(AlertService.createHumanHandoffAlert).toHaveBeenCalled();
});
test('redelivery of a single inbound message does not exhaust clarification attempts', async () => {
 const c=context(); await c.turn('My toilet is clogged');
 const request={...c,customerMessage:'purple elephants',turnId:'same-inbound-message'};
 await handleRecoveryIntake(request); await handleRecoveryIntake(request);
 expect(c.conversation.conversationMemory.recoveryIntake.failures).toBe(1);
});
