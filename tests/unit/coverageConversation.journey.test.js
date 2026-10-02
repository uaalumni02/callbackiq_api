jest.mock('../../src/services/serviceEligibility/serviceEligibility.service.js', () => ({ guardServiceRequest: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/helpers/ai/tools/validateServiceArea.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/getAvailability.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/searchServices.tool.js', () => ({ __esModule: true, default: jest.fn().mockResolvedValue([]) }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { createHumanHandoffAlert: jest.fn().mockResolvedValue({ alert: { _id: 'alert' } }) } }));
jest.mock('../../src/services/booking/approvedServiceEstimate.service.js', () => ({ getApprovedServiceEstimate: jest.fn().mockResolvedValue('') }));
import { handleRecoveryIntake } from '../../src/services/booking/recoveryIntake.service.js';
import validateServiceArea from '../../src/helpers/ai/tools/validateServiceArea.tool.js';
import getAvailability from '../../src/helpers/ai/tools/getAvailability.tool.js';
import { classifySmsIntent } from '../../src/services/messaging/smsIntentClassifier.service.js';
import { buildRequestReadiness } from '../../src/services/booking/requestQualificationPolicy.service.js';
const now = new Date('2026-09-19T17:40:00Z');
function context(service, channel = 'sms') {
 const c = { business: { _id: 'business', timezone: 'America/New_York', features: { aiBookingEnabled: false } },
 lead: { _id: 'lead', serviceNeeded: service, urgency: 'medium', address: '123 Pine Street Atlanta GA 30324', save: jest.fn().mockResolvedValue(null) },
 conversation: { _id: 'conversation', status: 'open', bookingState: { status: 'not_started' }, serviceEligibility: { decision: 'supported' }, conversationMemory: {},
 save: jest.fn().mockResolvedValue(null), markModified: jest.fn(), set(path, value) { this.conversationMemory.recoveryIntake = value; } }, channel, now };
 let id = 0;
 c.turn = customerMessage => handleRecoveryIntake({ ...c, customerMessage, turnId: String(++id) });
 return c;
}
beforeEach(() => { jest.clearAllMocks(); validateServiceArea.mockResolvedValue({ supported: null, reason: 'service_area_not_configured' }); });
test.each(['What are some appointment times?', 'Which appointment times are available?', 'Show me available time slots', 'When can someone come out?'])('availability language: %s', text => {
 expect(classifySmsIntent({ customerMessage: text }).intents.availabilityInquiry).toBe(true);
});
describe.each(['sms', 'voice'])('%s coverage review journey', channel => {
 test.each(['faucet replacement', 'AC maintenance', 'outlet replacement', 'roof inspection', 'garage door maintenance', 'lock replacement', 'lawn mowing', 'water damage restoration'])('%s retains facts and answers the current question', async service => {
  const c = context(service, channel);
  let r = await c.turn('What are some appointment times?');
  expect(r.reply).toMatch(/cannot offer appointment times.*coverage/i);
  expect(r.handoff.required).toBe(true);
  expect(r.reply).toMatch(/What day and time/);
  r = await c.turn('When can someone come out?');
  expect(r.reply).not.toMatch(/What day and time/);
  r = await c.turn('Monday 8 am');
  expect(c.lead.preferredAppointmentTime).toBe('2026-09-21 at 8:00 AM');
  expect(r.reply).toContain(c.lead.preferredAppointmentTime);
  expect(r.reply).toContain(service);
  expect(r.intakeReview.preferredAppointmentTime).toBe(c.lead.preferredAppointmentTime);
  expect(r.summary).toContain(c.lead.preferredAppointmentTime);
  r = await c.turn('Can you review your service area now?');
  expect(r.reply).toMatch(/rechecked.*cannot verify coverage/i);
  expect(validateServiceArea).toHaveBeenCalledTimes(4);
  expect(getAvailability).not.toHaveBeenCalled();
  r = await c.turn('Is my appointment confirmed?');
  expect(r.reply).toMatch(/(?:No appointment is confirmed|This is not a confirmed appointment)/);
  expect(r.reply).toMatch(/coverage still needs team review/i);
 });
 test('a new policy decision is used on recheck without treating it as a booking', async () => {
  const c = context('faucet replacement', channel);
  await c.turn('Monday 8 am');
  validateServiceArea.mockResolvedValue({ supported: true, reason: 'matched' });
  const r = await c.turn('Can you check coverage again?');
  expect(r.reply).toMatch(/30324 is covered/);
  expect(r.intakeReady).toBe(false);
  expect(c.conversation.conversationMemory.recoveryIntake.submitted).toBe(false);
  expect(getAvailability).not.toHaveBeenCalled();
  expect(c.lead.preferredAppointmentTime).toBe('2026-09-21 at 8:00 AM');
 });
 test('outside coverage remains a refusal and never offers times', async () => {
  const c = context('faucet replacement', channel);
  validateServiceArea.mockResolvedValue({ supported: false, reason: 'outside_configured_service_area' });
  const r = await c.turn('What are some appointment times?');
  expect(r.reply).toMatch(/outside the configured service area/);
  expect(r.intakeReady).toBe(false);
  expect(getAvailability).not.toHaveBeenCalled();
 });
 test('lookup outage remains unknown and cannot authorize approval', async () => {
  const c = context('faucet replacement', channel);
  validateServiceArea.mockRejectedValue(new Error('outage'));
  const r = await c.turn('Can you check coverage?');
  expect(r.qualificationReason).toBe('service_area_validation_unavailable');
  const state = c.conversation.conversationMemory.recoveryIntake;
  expect(buildRequestReadiness({ ...c, state }).readyForApproval).toBe(false);
  expect(r.reply).not.toMatch(/outside the configured/);
 });
 test('existing appointment is preserved during an unresolved coverage recheck', async () => {
  const c = context('faucet replacement', channel);
  c.conversation.bookingState = { status: 'booked', appointment: 'existing' };
  const r = await c.turn('Can you check coverage?');
  expect(c.conversation.bookingState.appointment).toBe('existing');
  expect(r.reply).toMatch(/does not change your existing appointment/);
  expect(r.reply).not.toMatch(/request is not a confirmed/);
 });
});
