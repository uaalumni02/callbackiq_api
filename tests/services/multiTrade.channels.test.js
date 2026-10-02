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

import { multiTradeCases, testOffering } from '../fixtures/multiTradeCases.js';
describe.each(['sms','voice'])('%s actual channel trade entry',channel=>{
 test.each(multiTradeCases)('$trade recognizes an owner-created offering through the channel handler',async row=>{
  business.businessType=row.trade;business.businessName=`Test ${row.trade}`;business.features.aiBookingEnabled=false;
  services=[testOffering(row)];const j=journey(channel);const r=await j.turn(row.request,true);
  expect(j.conversation().serviceEligibility).toMatchObject({decision:'supported',serviceId:'s1'});
  expect(j.lead().serviceNeeded).not.toBe('Unknown');expect(r.reply).not.toMatch(/does not offer|cannot verify that this business/i);
 });
});

describe.each([['sms', false], ['voice', false], ['sms', true], ['voice', true]])('%s contextual leak answer regression (booking=%s)', (channel, bookingEnabled) => {
  test.each(['When I use it', 'When we use the sink', 'While using it', 'During use', 'When I run the water', 'It leaks when I use it'])('%s advances to address collection', async answer => {
    business.features.aiBookingEnabled = bookingEnabled;
    const j = journey(channel);
    const first = await j.turn('My kitchen sink pipes are leaking', true);
    expect(first.reply).toMatch(/leaking right now.*only when/i);
    const result = await j.turn(answer, true);
    expect(result.reply).toMatch(/service address/i);
    expect(result.reply).not.toMatch(/coverage|team review/i);
    expect(j.conversation().conversationMemory.recoveryIntake).toMatchObject({
      triageResolved: true, triagePending: false, triageAnswer: answer, leakPattern: 'during_use',
    });
    expect(j.lead().serviceNeeded).toMatch(/kitchen sink/i);
    expect(validateServiceArea).not.toHaveBeenCalled();
    expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
    expect(qualifyLeadWithAI).not.toHaveBeenCalled();
  });
});


describe.each([['sms', false], ['voice', false], ['sms', true], ['voice', true]])('%s availability prerequisites (booking=%s)', (channel, bookingEnabled) => {
 test('asking for times during triage does not turn missing facts into a provider failure', async () => {
  business.features.aiBookingEnabled = bookingEnabled;
  const j = journey(channel);
  await j.turn('My kitchen sink pipes are leaking', true);
  const triage = await j.turn('What times are available?', true);
  expect(triage.reply).toMatch(/leaking right now/i);
  expect(triage.reply).not.toMatch(/failed|trouble|team review/i);
  await j.turn('When I use it', true);
  const address = await j.turn('What times are available?', true);
  expect(address.reply).toMatch(/service address/i);
  expect(Availability.getAvailability).not.toHaveBeenCalled();
  expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
 });
});

const intakeTrades = [
 ['plumbing', 'Faucet repair', 'My faucet is leaking', ['When I use it']],
 ['hvac', 'AC repair', 'My AC is not cooling', []],
 ['roofing', 'Roof repair', 'My roof is leaking', ['When it rains']],
 ['electrical', 'Outlet repair', 'My outlet has no power', ['Just this one']],
 ['restoration', 'Water damage assessment', 'I need a water damage assessment', ['The source is stopped']],
 ['garage_door', 'Garage door repair', 'My garage door spring snapped', ['Half open']],
 ['locksmith', 'Home lockout', 'I am locked out of my home', []],
 ['landscaping', 'Lawn mowing', 'I need lawn mowing', ['Just once']],
 ['appliance_repair', 'Refrigerator repair', 'My fridge is not cooling', []],
 ['other', 'Fence repair', 'I need fence repair', []],
];
describe.each([['sms', false], ['voice', false], ['sms', true], ['voice', true]])('%s full trade intake (booking=%s)', (channel, bookingEnabled) => {
 test.each(intakeTrades)('%s preserves qualification and advances through address to date', async (trade, name, request, answers) => {
  business.features.aiBookingEnabled = bookingEnabled;
  services = [{ ...plumbing, _id: trade, name, category: 'general', keywords: [] }];
  const j = journey(channel);
  let result = await j.turn(request, true);
  for (const answer of answers) result = await j.turn(answer, true);
  expect(result.reply).toMatch(/service address/i);
  const service = j.lead().serviceNeeded;
  result = await j.turn('123 Main Street Atlanta GA 30324', true);
  expect(result.reply).toMatch(/what day/i);
  expect(j.lead().address).toContain('123 Main Street');
  expect(j.lead().serviceNeeded).toBe(service);
  expect(j.conversation().conversationMemory.recoveryIntake.tradeQualification.status).toBe('clear');
  expect(AppointmentService.create).not.toHaveBeenCalled();
  expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
 });
});

describe.each(['sms', 'voice'])('%s short activity answers', channel => {
 test.each([
  ['Right now', 'active', 'high'], ['All the time', 'active', 'high'], ['Constantly', 'active', 'high'],
  ['Not right now', 'not_active', 'low'], ['Not anymore', 'not_active', 'low'], ['It stopped', 'not_active', 'low'],
 ])('%s resolves the pending question without a model fallback', async (answer, pattern, urgency) => {
  business.features.aiBookingEnabled = false;
  const j = journey(channel);
  await j.turn('My kitchen sink pipes are leaking', true);
  const result = await j.turn(answer, true);
  expect(result.reply).toMatch(/service address/i);
  expect(j.conversation().conversationMemory.recoveryIntake).toMatchObject({ triageAnswer: answer, triageResolved: true, leakPattern: pattern });
  if (pattern === 'active') expect(j.lead().urgency).toBe(urgency);
  else expect(['high', 'emergency']).not.toContain(j.lead().urgency);
 });
});
