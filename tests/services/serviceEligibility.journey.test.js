import validateServiceArea from '../../src/helpers/ai/tools/validateServiceArea.tool.js';
jest.mock('../../src/helpers/ai/tools/validateServiceArea.tool.js', () => ({ __esModule: true, default: jest.fn() }));
import { guardServiceRequest, assertServiceRequestEligible } from '../../src/services/serviceEligibility/serviceEligibility.service.js';
import { generateAIReplyResult } from '../../src/services/aiReplyService.js';
import VoiceAgent from '../../src/voice/voiceAgent.service.js';
import VoiceUnderstanding from '../../src/voice/voiceUnderstanding.service.js';
import ServiceOffering from '../../src/models/serviceOffering.js';
import Operations from '../../src/models/businessOperationsSettings.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import AlertService from '../../src/services/alert.service.js';
import Availability from '../../src/services/scheduling/availability.service.js';
import AppointmentService from '../../src/services/scheduling/appointment.service.js';
import getAvailability from '../../src/helpers/ai/tools/getAvailability.tool.js';
import createAppointment from '../../src/helpers/ai/tools/createAppointment.tool.js';
import { getApprovedServiceEstimate } from '../../src/services/booking/approvedServiceEstimate.service.js';
import { qualifyLeadWithAI } from '../../src/helpers/ai/qualifyLeadWithAI.js';
import { reserveAiUsage } from '../../src/services/communicationUsage.service.js';
import VoiceCallback from '../../src/voice/voiceCallback.service.js';

jest.mock('../../src/models/serviceOffering.js', () => ({ __esModule: true, default: { find: jest.fn() } }));
jest.mock('../../src/models/businessOperationsSettings.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/models/lead.js', () => ({ __esModule: true, default: { findOne: jest.fn(), findOneAndUpdate: jest.fn() } }));
jest.mock('../../src/models/conversation.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { create: jest.fn(), createHumanHandoffAlert: jest.fn() } }));
jest.mock('../../src/services/scheduling/availability.service.js', () => ({ __esModule: true, default: { getAvailability: jest.fn() } }));
jest.mock('../../src/services/scheduling/appointment.service.js', () => ({ __esModule: true, default: { create: jest.fn() } }));
jest.mock('../../src/helpers/ai/qualifyLeadWithAI.js', () => ({ qualifyLeadWithAI: jest.fn() }));
jest.mock('../../src/services/communicationUsage.service.js', () => ({ reserveAiUsage: jest.fn() }));
jest.mock('../../src/voice/voiceUnderstanding.service.js', () => ({ __esModule: true, default: { classifyVoiceTurn: jest.fn() } }));
jest.mock('../../src/voice/voiceCallback.service.js', () => ({ __esModule: true, default: { isActive: jest.fn(), handle: jest.fn() } }));

let services, policy;
const plumbing = { _id: 'plumbing', business: 'b', active: true, name: 'Plumbing service', category: 'plumbing', aiCanDiscuss: true, aiCanBook: true, keywords: ['repair', 'install', 'leak'], disclosePriceEstimate: true, priceEstimateMin: 100, priceEstimateMax: 200 };
const business = { _id: 'b', businessName: 'Plumbing Co', timezone: 'America/New_York', features: { aiBookingEnabled: true } };
const query = value => ({ lean: jest.fn(async () => value), select() { return this; } });
const durable = initial => {
  let saved = JSON.parse(JSON.stringify(initial));
  return { read() { return { ...structuredClone(saved), markModified() {}, async save() { saved = JSON.parse(JSON.stringify(this)); } }; }, snapshot() { return saved; } };
};
function journey(channel = 'sms') {
  const l = durable({ _id: 'l', business: 'b', serviceNeeded: 'Unknown', phone: '+14045550101', urgency: 'low', estimatedValue: 999, valuation: { source: 'service_catalog' }, qualifiedAt: '2026-01-01' });
  const c = durable({ _id: 'c', business: 'b', lead: 'l', status: 'open', customerPhone: '+14045550101', bookingState: { status: 'not_started' }, conversationMemory: {}, orchestration: {} });
  let n = 0;
  return { lead: l.snapshot, conversation: c.snapshot, async turn(text, throughChannel = false) {
    const lead = l.read(), conversation = c.read();
    Lead.findOne.mockReturnValue(query(lead)); Conversation.findOne.mockReturnValue(query(conversation));
    if (throughChannel && channel === 'sms') return generateAIReplyResult({ business, lead, conversation, customerMessage: text, messages: [{ _id: `m${++n}`, direction: 'inbound', body: text }] });
    if (throughChannel && channel === 'voice') return VoiceAgent.handlePromptInternal({ session: { _id: 'v', business, lead, conversation, metadata: {}, transcript: [], save: jest.fn() }, customerMessage: text, turnId: `v${++n}` });
    return guardServiceRequest({ business, lead, conversation, customerMessage: text, channel, turnId: String(++n) });
  } };
}
beforeEach(() => {
  jest.clearAllMocks(); business.features.aiBookingEnabled = true; services = [plumbing]; policy = { catalogComplete: true };
  ServiceOffering.find.mockImplementation(() => query(services));
  Operations.findOne.mockImplementation(() => query({ serviceEligibilityPolicy: policy }));
  AlertService.create.mockResolvedValue({ alert: { _id: 'alert' } });
  AlertService.createHumanHandoffAlert.mockResolvedValue({ alert: { _id: 'handoff' } });
  validateServiceArea.mockResolvedValue({ supported: true, reason: 'matched' });
  Lead.findOneAndUpdate.mockReturnValue(query(null));
  reserveAiUsage.mockResolvedValue({ allowed: true });
  qualifyLeadWithAI.mockResolvedValue({ isInScope: true, serviceNeeded: '', confidence: 10 });
  VoiceUnderstanding.classifyVoiceTurn.mockResolvedValue({ intent: 'service_request', confidence: 90, entities: { service: '' }, safety: { isEmergency: false }, language: 'en' });
  VoiceCallback.handle.mockResolvedValue({ reply: 'Safety response' });
});
test.each(['sms', 'voice'])('%s actual channel declines roof repair without side effects', async channel => {
  const j = journey(channel); const reply = await j.turn('I need roof repair', true);
  expect(reply.reply).toMatch(/does not offer/);
  expect(j.conversation().serviceEligibility.decision).toBe('unsupported');
  expect(j.lead()).toMatchObject({ qualifiedAt: null, estimatedValue: null, leadQualityScore: 0 });
  expect(Availability.getAvailability).not.toHaveBeenCalled(); expect(AppointmentService.create).not.toHaveBeenCalled(); expect(AlertService.create).not.toHaveBeenCalled();
});
test.each(['sms', 'voice'])('%s reloads uncertainty and respects staff-review consent', async channel => {
  const j = journey(channel);
  expect((await j.turn('Water is leaking through my ceiling', true)).reply).toMatch(/pipe.*roof/);
  expect((await j.turn('I am unsure', true)).reply).toMatch(/staff review/);
  expect(AlertService.create).not.toHaveBeenCalled();
  expect((await j.turn('yes', true)).reply).toMatch(/saved for staff/);
  expect(AlertService.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Service eligibility needs review' }));
  expect(j.conversation().serviceEligibility.reviewSubmitted).toBe(true);
  expect(AppointmentService.create).not.toHaveBeenCalled(); expect(Availability.getAvailability).not.toHaveBeenCalled();
});
test('incomplete catalog does not claim unsupported; explicit exclusion does', async () => {
  policy = { catalogComplete: false }; const j = journey();
  expect((await j.turn('roof repair')).serviceEligibility.decision).toBe('needs_staff_review');
  policy.excludedServices = ['roof repair'];
  expect((await j.turn('roof repair')).serviceEligibility.decision).toBe('unsupported');
});
test('supported request can replace rejected request without deleting customer history', async () => {
  const j = journey(); await j.turn('roof repair');
  expect(await j.turn('Actually I need toilet repair')).toBeNull();
  expect(j.lead().serviceEligibility.decision).toBe('supported');
  expect(j.lead().serviceNeeded).toMatch(/toilet/);
});
test('service change invalidates stale offers and completed intake', async () => {
  const lead = { serviceNeeded: 'toilet repair', save: jest.fn() };
  const conversation = { serviceEligibility: { decision: 'supported', request: 'toilet repair', serviceId: 'plumbing' }, bookingState: { status: 'offering_slots', offeredSlots: [{}] }, conversationMemory: { recoveryIntake: { reviewReady: true } }, save: jest.fn() };
  const result = await guardServiceRequest({ business, lead, conversation, customerMessage: 'Instead I need roof repair' });
  expect(result.serviceEligibility.decision).toBe('unsupported'); expect(conversation.bookingState).toEqual({ status: 'not_started' });
  expect(conversation.conversationMemory.recoveryIntake).toEqual({});
});
test('tool boundaries reject forged selected service before calendar or appointment writes', async () => {
  Lead.findOne.mockReturnValue(query({ serviceNeeded: 'roof repair' })); Conversation.findOne.mockReturnValue(query({ serviceEligibility: { decision: 'unsupported', request: 'roof repair' } }));
  await expect(getAvailability({ business, leadId: 'l', conversationId: 'c', serviceOfferingId: 'plumbing', serviceQuery: 'toilet repair' })).rejects.toMatchObject({ code: 'SERVICE_ELIGIBILITY_REQUIRED' });
  await expect(createAppointment({ business, input: { lead: 'l', conversation: 'c', serviceOfferingId: 'plumbing', serviceQuery: 'toilet repair' } })).rejects.toMatchObject({ code: 'SERVICE_ELIGIBILITY_REQUIRED' });
  expect(Availability.getAvailability).not.toHaveBeenCalled(); expect(AppointmentService.create).not.toHaveBeenCalled();
});
test('pricing cannot reuse old plumbing context for new roofing request', async () => {
  expect(await getApprovedServiceEstimate({ businessId: 'b', serviceNeeded: 'toilet repair', customerMessage: 'How much for roof repair?' })).toBe('');
});
test('tool validates tenant and discussion-only permission', async () => {
  Lead.findOne.mockReturnValue(query(null));
  await expect(assertServiceRequestEligible({ businessId: 'b', leadId: 'foreign', serviceOfferingId: 'plumbing', request: 'toilet repair' })).rejects.toMatchObject({ code: 'SERVICE_CONTEXT_NOT_FOUND' });
});
test('catalog failure closes automation without inventing a refusal', async () => {
  Operations.findOne.mockImplementation(() => { throw new Error('unavailable'); });
  const j = journey(); expect((await j.turn('roof repair')).serviceEligibility.reason).toBe('catalog_unavailable');
});
test('existing appointment cancel and consent commands bypass eligibility intake', async () => {
  const j = journey(); await j.turn('roof repair');
  expect(await j.turn('cancel my appointment')).toBeNull(); expect(await j.turn('STOP')).toBeNull();
});
test('semantic interpretation cannot authorize work not in catalog', async () => {
  const j = journey();
  qualifyLeadWithAI.mockResolvedValue({ isInScope: true, serviceNeeded: 'roof repair', confidence: 95 });
  const result = await j.turn('I need the covering on my house fixed');
  expect(result.serviceEligibility.decision).toBe('unsupported');
});

test.each(['sms', 'voice'])('%s supported request still advances intake', async channel => {
  const j = journey(channel);
  business.features.aiBookingEnabled = false;
  const result = await j.turn('I need toilet repair', true);
  expect(result.reply).toMatch(/service address/i);
  expect(j.conversation().serviceEligibility.decision).toBe('supported');
});
test('SMS safety overrides an earlier unsupported service decision', async () => {
  const j = journey(); await j.turn('roof repair');
  const result = await j.turn('I smell gas in the house', true);
  expect(result.messageCategory).toBe('emergency'); expect(result.reply).not.toMatch(/does not offer/);
  expect(AppointmentService.create).not.toHaveBeenCalled();
});
test('voice safety overrides an earlier unsupported service decision', async () => {
  const j = journey('voice'); await j.turn('roof repair');
  VoiceUnderstanding.classifyVoiceTurn.mockResolvedValue({ entities: {}, safety: { isEmergency: true, hazardType: 'gas', reply: 'Leave the area and call emergency services.' } });
  await j.turn('I smell gas in the house', true);
  expect(VoiceCallback.handle).toHaveBeenCalledWith(expect.objectContaining({ reason: 'safety_emergency:gas' }));
  expect(AppointmentService.create).not.toHaveBeenCalled();
});
test('bookability is checked independently at the tool boundary', async () => {
  const j = journey(); await j.turn('toilet repair');
  services = [{ ...plumbing, aiCanBook: false }];
  await expect(assertServiceRequestEligible({ businessId: 'b', leadId: 'l', serviceOfferingId: 'plumbing', request: 'toilet repair' })).rejects.toMatchObject({ code: 'SERVICE_ELIGIBILITY_REQUIRED' });
});
test('review persistence failure never claims submission succeeded', async () => {
  policy = {}; const j = journey(); await j.turn('roof repair');
  AlertService.create.mockResolvedValue({ alert: null });
  await expect(j.turn('yes')).rejects.toMatchObject({ code: 'SERVICE_REVIEW_NOT_SAVED' });
  expect(j.conversation().serviceEligibility.reviewSubmitted).toBe(false);
});
test('configuration changed after intake is enforced at the booking boundary', async () => {
  const j = journey(); await j.turn('toilet repair');
  policy.excludedServices = ['toilet repair'];
  await expect(assertServiceRequestEligible({ businessId: 'b', leadId: 'l', conversationId: 'c', serviceOfferingId: 'plumbing' })).rejects.toMatchObject({ code: 'SERVICE_ELIGIBILITY_REQUIRED' });
});
test('cancel an existing appointment remains possible when that service is no longer offered', async () => {
  expect(await guardServiceRequest({ business, lead: { serviceNeeded: 'roof repair' }, conversation: {
    bookingState: { appointment: 'existing', status: 'booked' }, serviceEligibility: { decision: 'unsupported', request: 'roof repair' },
  }, customerMessage: 'Cancel my roof repair appointment' })).toBeNull();
});


test.each(['sms', 'voice'])('%s symptom negation preserves the saved request and triage', async channel => {
  const j = journey(channel); await j.turn('My bathtub is leaking');
  for (const text of ['No longer leaking', 'Not overflowing', 'Stopped overflowing']) {
    expect(await j.turn(text)).toBeNull();
    expect(j.conversation().serviceEligibility).toMatchObject({ decision: 'supported', request: 'My bathtub is leaking' });
    expect(j.lead().serviceNeeded).toMatch(/bathtub/);
  }
  await j.turn('Actually my roof needs repair');
  expect(j.conversation().serviceEligibility.decision).toBe('unsupported');
});
test('soft opt-out bypasses catalog reads and eligibility persistence', async () => {
  const lead = { serviceNeeded: 'toilet repair', save: jest.fn() };
  const conversation = { status: 'open', save: jest.fn() };
  expect(await guardServiceRequest({ business, lead, conversation, customerMessage: 'Please stop texting me' })).toBeNull();
  expect(ServiceOffering.find).not.toHaveBeenCalled();
  expect(lead.save).not.toHaveBeenCalled(); expect(conversation.save).not.toHaveBeenCalled();
});
test('a supplied supported query without saved context cannot authorize a booking tool', async () => {
  await expect(createAppointment({ business, input: { serviceOfferingId: 'plumbing', serviceQuery: 'toilet repair' } })).rejects.toMatchObject({ code: 'SERVICE_ELIGIBILITY_REQUIRED' });
  expect(AppointmentService.create).not.toHaveBeenCalled();
});
test('a supplied query cannot override a legacy lead that has no eligibility state', async () => {
  Lead.findOne.mockReturnValue(query({ _id: 'l', business: 'b', serviceNeeded: 'roof repair' }));
  await expect(getAvailability({ business, leadId: 'l', serviceOfferingId: 'plumbing', serviceQuery: 'toilet repair' })).rejects.toMatchObject({ code: 'SERVICE_ELIGIBILITY_REQUIRED' });
  expect(Availability.getAvailability).not.toHaveBeenCalled();
});

test('withdrawn requests cannot be booked or approved by staff', async () => {
  Lead.findOne.mockReturnValue(query({ _id: 'l', business: 'b', serviceNeeded: 'sink repair' }));
  Conversation.findOne.mockReturnValue(query({ _id: 'c', business: 'b', orchestration: { recoveryJourneyKey: 'current' },
    conversationMemory: { recoveryIntake: { journeyKey: 'current', withdrawnAt: new Date() } } }));
  for (const allowStaffReview of [false, true]) {
    await expect(assertServiceRequestEligible({ businessId: 'b', leadId: 'l', conversationId: 'c', serviceOfferingId: 'plumbing', allowStaffReview }))
      .rejects.toMatchObject({ code: 'SERVICE_REQUEST_WITHDRAWN' });
  }
  expect(Conversation.findOne).toHaveBeenCalledWith({ _id: 'c', business: 'b' });
});

test.each([
  ['plumbing', 'My kitchen sink is clogged'],
  ['hvac', 'My furnace is broken'],
  ['electrical', 'My outlet is broken'],
  ['roofing', 'I need roof repair'],
  ['restoration', 'I need water damage restoration'],
  ['garage_door', 'My garage door is stuck'],
  ['locksmith', 'My door lock is broken'],
  ['landscaping', 'I need the hedges trimmed'],
])('%s retains approved work through a contextual pricing follow-up', async (category, request) => {
  services = [{ ...plumbing, _id: category, category, name: `${category} service`, keywords: [request.replace(/^I need /i, "")], excludedKeywords: [] }];
  const j = journey();
  expect(await j.turn(request)).toBeNull();
  const before = j.lead().serviceNeeded;
  expect(await j.turn('Tomorrow at 9pm. How much would it cost to fix something like this?')).toBeNull();
  expect(j.lead().serviceNeeded).toBe(before);
  expect(j.conversation().serviceEligibility.decision).toBe('supported');
});

test.each(['sms', 'voice'])('%s actual entry point persists vague-problem clarification across reloads', async channel => {
 business.features.aiBookingEnabled = false;
 const j = journey(channel);
 const first = await j.turn('My toilet is broken', true);
 expect(first.reply).toMatch(/what is happening/i);
 expect(j.conversation().conversationMemory.recoveryIntake.problem.status).toBe('needs_clarification');
 const next = await j.turn("It won't flush", true);
 expect(next.reply).toMatch(/service address/i);
 expect(j.conversation().conversationMemory.recoveryIntake.problem.status).toBe('clear');
 validateServiceArea.mockResolvedValue({ supported: false, reason: 'outside_configured_service_area' });
 const outside = await j.turn('123 Easy Street Bessemer AL 35022', true);
 expect(outside.reply).toMatch(/outside the configured service area/i);
 expect(j.lead().address).toContain('35022');
 expect(Availability.getAvailability).not.toHaveBeenCalled();
 expect(AppointmentService.create).not.toHaveBeenCalled();
});
test.each(['sms', 'voice'])('%s actual entry point routes unknown coverage to review with a tentative preference', async channel => {
 business.features.aiBookingEnabled = false;
 const j = journey(channel); await j.turn('Replace my faucet', true);
 validateServiceArea.mockResolvedValue({ supported: null, reason: 'service_area_not_configured' });
 const reply = await j.turn('123 Easy Street Bessemer AL 35022', true);
 expect(reply.reply).toMatch(/coverage.*review/i);
 expect(reply.reply).toMatch(/preference for review/i);
 expect(reply.reply).not.toMatch(/currently available/i);
 expect(j.conversation().conversationMemory.recoveryIntake.readiness.readyForOptions).toBe(false);
 expect(Availability.getAvailability).not.toHaveBeenCalled();
 if (channel === 'voice') expect(AlertService.createHumanHandoffAlert).toHaveBeenCalled();
});
test('calendar and create tools independently reject unresolved problem clarity', async () => {
 const j = journey(); await j.turn('My toilet is broken', true);
 // Tools must not trust a model-supplied alternative request or offering.
 await expect(getAvailability({ business, leadId: 'l', conversationId: 'c', serviceOfferingId: 'plumbing', serviceQuery: 'install faucet' })).rejects.toMatchObject({ code: 'REQUEST_QUALIFICATION_REQUIRED' });
 await expect(createAppointment({ business, input: { lead: 'l', conversation: 'c', serviceOfferingId: 'plumbing', serviceQuery: 'install faucet' } })).rejects.toMatchObject({ code: 'REQUEST_QUALIFICATION_REQUIRED' });
 expect(Availability.getAvailability).not.toHaveBeenCalled();
 expect(AppointmentService.create).not.toHaveBeenCalled();
});

describe.each(['sms', 'voice'])('%s cross-trade qualification through actual entry point', channel => {
 test.each([
   ['plumbing', 'Plumbing', 'My toilet is broken'],
   ['hvac', 'HVAC', 'My AC is not working'],
   ['electrical', 'Electrical', 'My outlet is broken'],
   ['roofing', 'Roofing', 'My roof is damaged'],
   ['restoration', 'Restoration', 'I need restoration for damage'],
   ['garage_door', 'Garage door', 'My garage door is not working'],
   ['locksmith', 'Locksmith', 'My door lock is broken'],
   ['landscaping', 'Landscaping', 'My sprinkler has a problem'],
 ])('%s saves a clarification without calendar or booking side effects', async (category, name, request) => {
   business.features.aiBookingEnabled = false;
   services = [{ ...plumbing, _id: category, category, name, keywords: [] }];
   const j = journey(channel);
   const result = await j.turn(request, true);
   expect(result.reply).toContain('?');
   expect(j.conversation().conversationMemory.recoveryIntake.problem.status).toBe('needs_clarification');
   expect(Availability.getAvailability).not.toHaveBeenCalled();
   expect(AppointmentService.create).not.toHaveBeenCalled();
 });
});

 test.each(['sms', 'voice'])('%s actual entry preserves coverage and preference across repeated questions and reloads', async channel => {
  business.features.aiBookingEnabled = false;
  const j = journey(channel);
  await j.turn('Replace my faucet', true);
  validateServiceArea.mockResolvedValue({ supported: null, reason: 'service_area_not_configured' });
  await j.turn('123 Pine Street Atlanta GA 30324', true);
  for (const text of ['When can someone come out?', 'What are some appointment times?']) {
   const r = await j.turn(text, true);
   expect(r.reply).toMatch(/cannot offer appointment times.*coverage/i);
   expect(r.reply).not.toMatch(/What day and time/);
  }
  const preference = await j.turn('Monday 8 am', true);
  expect(preference.reply).toMatch(/preferred time/);
  expect(j.lead().preferredAppointmentTime).toMatch(/8:00/);
  const review = await j.turn('Can you review your service area now?', true);
  expect(review.reply).toMatch(/rechecked.*cannot verify/i);
  expect(Availability.getAvailability).not.toHaveBeenCalled();
  expect(AppointmentService.create).not.toHaveBeenCalled();
 });
