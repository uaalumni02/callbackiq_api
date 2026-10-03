import { voiceSafetyAssessment } from '../../src/services/voiceSafetyReview.service.js';
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


describe.each(['sms','voice'])('%s review probes', channel => {
 test.each(['Leaking now','Still leaking bad','Still leaking a lot','Yes, it is leaking now','It leaks when I turn the faucet on','It stopped after I shut off the water'])('pending leak: %s',async answer=>{
  business.features.aiBookingEnabled=false;const j=journey(channel);
  const first=await j.turn('I have a pipe that is leaking',true);
  const before=j.lead().serviceNeeded;
  const r=await j.turn(answer,true);
  console.log('REVIEW_PROBE',JSON.stringify({channel,answer,first:first.reply,before,after:j.lead().serviceNeeded,urgency:j.lead().urgency,decision:j.conversation().serviceEligibility?.decision,reply:r.reply}));
  expect(j.lead().serviceNeeded).toBe(before);
  if (/Still leaking|Leaking now|Yes, it is/i.test(answer)) expect(j.lead().urgency).toBe('high');
  expect(r.reply).not.toBe(first.reply);
 });
 test('HVAC symptom reply',async()=>{
  business.features.aiBookingEnabled=false;
  services=[{...plumbing,name:'Furnace repair',category:'hvac',keywords:['furnace','heating']}];
  const j=journey(channel);const first=await j.turn('I need furnace repair',true);const before=j.lead().serviceNeeded;
  const r=await j.turn('its not heating',true);
  console.log('REVIEW_PROBE',JSON.stringify({channel,answer:'its not heating',first:first.reply,before,after:j.lead().serviceNeeded,decision:j.conversation().serviceEligibility?.decision,reply:r.reply}));
  expect(j.lead().serviceNeeded).toMatch(/furnace/i);
 });
 test.each(['My toilet is overflowing','My toilet is overflowing at 123 Main Street Atlanta GA 30324'])('urgent plumbing: %s',async text=>{
  business.features.aiBookingEnabled=false;const j=journey(channel);const r=await j.turn(text,true);
  console.log('REVIEW_PROBE',JSON.stringify({channel,text,reply:r.reply,lead:j.lead().serviceNeeded}));
  if (channel === 'voice') expect(voiceSafetyAssessment(text)).toBeNull();
  else expect(r.reply).not.toMatch(/Contact a qualified professional/);
 });
});

describe.each(['sms','voice'])('%s cross-trade symptom continuity',channel=>{
 test.each([
  ['Furnace repair','hvac','its not heating'],['Roof repair','roofing','Still leaking bad'],
  ['Outlet repair','electrical','it is still dead'],['Water damage restoration','restoration','it is still wet'],
  ['Garage door repair','garage_door',"it won't open"],['Door lock repair','locksmith',"it won't lock"],
  ['Sprinkler repair','landscaping','it keeps leaking'],
 ])('%s preserves its identity after %s',async(name,category,answer)=>{
  business.features.aiBookingEnabled=false;services=[{...plumbing,name,category,keywords:[name.toLowerCase()]}];
  const j=journey(channel);await j.turn(`I need ${name.toLowerCase()}`,true);const before=j.lead().serviceNeeded;
  await j.turn(answer,true);expect(j.lead().serviceNeeded).toBe(before);
 });
});
