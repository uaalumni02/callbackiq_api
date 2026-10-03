import { guardServiceRequest, assertServiceRequestEligible } from '../../src/services/serviceEligibility/serviceEligibility.service.js';
import { generateAIReplyResult } from '../../src/services/aiReplyService.js';
import VoiceAgent from '../../src/voice/voiceAgent.service.js';
import VoiceUnderstanding from '../../src/voice/voiceUnderstanding.service.js';
import ServiceArea from '../../src/models/serviceArea.js';
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

jest.mock('../../src/models/serviceArea.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/models/serviceOffering.js', () => ({ __esModule: true, default: { find: jest.fn(), findOne: jest.fn() } }));
jest.mock('../../src/models/businessOperationsSettings.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/models/lead.js', () => ({ __esModule: true, default: { findOne: jest.fn(), findOneAndUpdate: jest.fn() } }));
jest.mock('../../src/models/conversation.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { create: jest.fn(), createHumanHandoffAlert: jest.fn(), createSystemAlert: jest.fn() } }));
jest.mock('../../src/services/scheduling/availability.service.js', () => ({ __esModule: true, default: { getAvailability: jest.fn() } }));
jest.mock('../../src/services/scheduling/appointment.service.js', () => ({ __esModule: true, default: { create: jest.fn(), createHumanHandoffAlert: jest.fn(), createSystemAlert: jest.fn() } }));
jest.mock('../../src/helpers/ai/qualifyLeadWithAI.js', () => ({ qualifyLeadWithAI: jest.fn() }));
jest.mock('../../src/services/communicationUsage.service.js', () => ({ reserveAiUsage: jest.fn() }));

jest.mock('../../src/voice/voiceCallback.service.js', () => ({ __esModule: true, default: { isActive: jest.fn(), handle: jest.fn() } }));

let services, policy;
const plumbing = { _id: 'plumbing', business: 'b', active: true, name: 'Plumbing service', category: 'plumbing', aiCanDiscuss: true, aiCanBook: true, keywords: ['repair', 'install', 'leak'], disclosePriceEstimate: true, priceEstimateMin: 100, priceEstimateMax: 200 };
const business = { _id: 'b', businessName: 'Plumbing Co', timezone: 'America/New_York', features: { aiBookingEnabled: true } };
const query = value => ({ lean: jest.fn(async () => value), select() { return this; } });
const durable = initial => {
  let saved = JSON.parse(JSON.stringify(initial));
  return { read() { return { ...structuredClone(saved), set(path, value) { const keys=path.split('.'); let target=this; for(const key of keys.slice(0,-1)) target=target[key] ||= {}; target[keys.at(-1)]=value; }, markModified() {}, async populate() { return this; }, async save() { saved = JSON.parse(JSON.stringify(this)); } }; }, snapshot() { return saved; } };
};
function journey(channel = 'sms') {
  const l = durable({ _id: 'l', business: 'b', serviceNeeded: 'Unknown', phone: '+14045550101', urgency: 'low', estimatedValue: 999, valuation: { source: 'service_catalog' }, qualifiedAt: '2026-01-01' });
  const c = durable({ _id: 'c', business: 'b', lead: 'l', status: 'open', customerPhone: '+14045550101', bookingState: { status: 'not_started' }, conversationMemory: {}, orchestration: {} });
  let n = 0; const history=[];
  return { lead: l.snapshot, conversation: c.snapshot, async turn(text, throughChannel = false) {
    const lead = l.read(), conversation = c.read(); history.push({_id:`m${++n}`,direction:'inbound',body:text,createdAt:new Date()});
    Lead.findOne.mockReturnValue(query(lead)); Conversation.findOne.mockReturnValue(query(conversation));
    if (throughChannel && channel === 'sms') return generateAIReplyResult({ business, lead, conversation, customerMessage: text, messages: history });
    if (throughChannel && channel === 'voice') return VoiceAgent.handlePromptInternal({ session: { _id: 'v', business, lead, conversation, metadata: {}, transcript: history.map(m=>({role:'customer',text:m.body,at:m.createdAt})), save: jest.fn() }, customerMessage: text, turnId: `v${++n}` });
    return guardServiceRequest({ business, lead, conversation, customerMessage: text, channel, turnId: String(++n) });
  } };
}
beforeEach(() => {
  jest.clearAllMocks(); business.features.aiBookingEnabled = false; services = [plumbing]; policy = { catalogComplete: true };
  ServiceArea.findOne.mockReturnValue(query({ type: 'zip_codes', zipCodes: ['30324', '30326', '30303'] }));
  ServiceOffering.find.mockImplementation(filter => query(services.filter(s=>Object.entries(filter).every(([key,value])=>s[key]===value))));
  ServiceOffering.findOne.mockImplementation(filter=>query(services.find(s=>Object.entries(filter).every(([key,value])=>s[key]===value))));
  Operations.findOne.mockImplementation(() => query({ serviceEligibilityPolicy: policy }));
  AlertService.create.mockResolvedValue({ alert: { _id: 'alert' } });
 AlertService.createHumanHandoffAlert.mockResolvedValue({alert:{_id:'handoff'}});
 AlertService.createSystemAlert.mockResolvedValue({alert:{_id:'provider'}});
  Lead.findOneAndUpdate.mockReturnValue(query(null));
  reserveAiUsage.mockResolvedValue({ allowed: true });
  qualifyLeadWithAI.mockResolvedValue({ isInScope: true, serviceNeeded: '', confidence: 10 });
  delete process.env.OPENAI_API_KEY;
  VoiceCallback.handle.mockResolvedValue({ reply: 'Safety response' });
});

jest.mock('../../src/helpers/ai/tools/getAvailability.tool.js',()=>({__esModule:true,default:jest.fn()}));
const trades = [
 ['plumbing','My kitchen faucet is loose and needs to be replaced'],
 ['hvac','My air conditioner is noisy and needs repair'],
 ['electrical','My light switch is broken and needs replacement'],
 ['roofing','My roof needs inspection'],
 ['restoration','I need water damage restoration'],
 ['garage_door','My garage door is noisy and needs repair'],
 ['locksmith','I need door lock replacement'],
 ['landscaping','I need hedge trimming'],
];
const addresses = [
 '970 Sidney Marcus Atlanta, Ga 30324',
 'My address is 970 Sidney Marcus Atlanta GA 30324',
 '970 Sidney Marcus Blvd NE Apt 4 Atlanta GA 30324',
 'nine seventy Sidney Marcus Atlanta GA zip three zero three two four',
 '970 Sidney Marcus Atlanta GA 30324-1234',
 '970 Sidney Marcus',
];
const questions = ['How much?', 'What is the estimated price to repair and when can you come fix it?', 'Can I schedule an appointment?', 'How much to fix it?', 'What is available?', 'I just told you the address'];
const cases=trades.flatMap(([trade,request])=>addresses.flatMap(address=>questions.flatMap(question=>['sms','voice'].flatMap(channel=>[true,false].map(pricing=>({trade,request,address,question,channel,pricing}))))));
beforeEach(()=> {
 getAvailability.mockResolvedValue({supportedServiceArea:true,slots:[{startAt:new Date(Date.now()+3*86400000).toISOString(),endAt:new Date(Date.now()+3*86400000+3600000).toISOString()}]});
});
test.each(cases)('durable channel journey %# $channel $trade $address $question pricing=$pricing', async ({trade,request,address,question,channel,pricing})=> {
 services=[{...plumbing,_id:trade,name:trade==='garage_door'?'Garage door service':`${trade} service`,category:trade,keywords:[],disclosePriceEstimate:pricing}];
 const j=journey(channel);
 let first=await j.turn(request,true);
 if(trade==='restoration'){expect(first.reply).toMatch(/spreading/);first=await j.turn('The source is stopped',true);}
 if(trade==='garage_door'){expect(first.reply).toMatch(/open.*closed/);first=await j.turn('The door is closed',true);}
 expect(first.reply).toMatch(/service address/);
 const savedService=j.lead().serviceNeeded;
 const captured=await j.turn(address,true);
 expect(captured.reply).not.toMatch(/what is the service address|can't verify|needs to review/i);
 expect(j.lead().address).toContain('970 Sidney Marcus');
 expect(j.lead().preferredAppointmentTime || '').toBe('');
 if(address==='970 Sidney Marcus') await j.turn('30324',true);
 const result=await j.turn(question,true);
 expect(result.reply).not.toMatch(/can't verify that this business|what service do you need|what is the service address|does not offer/i);
 expect(j.lead().serviceNeeded).toBe(savedService);
 expect(j.lead().address).toContain('30324');
 expect(j.conversation().serviceEligibility.decision).toBe('supported');
 if(/much|price/.test(question)) {
  if(pricing) expect(result.reply).toContain('$100');
  else expect(result.reply).not.toMatch(/\$\d/);
 }
 if(/when|available/.test(question)) { expect(getAvailability).toHaveBeenCalled(); if(channel==='sms') expect(result.reply.length).toBeLessThanOrEqual(320); }
 expect(AppointmentService.create).not.toHaveBeenCalled();
});

test.each(['sms','voice'])('%s exact reported transcript retains faucet and address through scheduling',async channel=>{
 const j=journey(channel);
 const replies=[];
 for(const turn of ['My kitchen faucet is loose and needs to be replaced','970 Sidney Marcus Atlanta, Ga 30324','I just told you the address','What is the estimated price to repair and when can you come fix it?','Can I schedule an appointment?']) replies.push((await j.turn(turn,true)).reply);
 expect(replies.join(' ')).not.toMatch(/can't verify that this business|team member needs to review|what service do you need/i);
 expect(replies[3]).toContain('$100'); expect(replies[3]).toMatch(/Current openings/);
 expect(j.lead().serviceNeeded).toContain('kitchen faucet'); expect(j.lead().address).toContain('30324');
 expect(AppointmentService.create).not.toHaveBeenCalled();
});
test.each(['sms','voice'])('%s staff review remains actionable and retains additional facts',async channel=>{
 services=[]; policy={catalogComplete:false}; const j=journey(channel);
 await j.turn('I need faucet replacement',true);
 expect(AlertService.create).toHaveBeenCalledWith(expect.objectContaining({actionRequired:true}));
 await j.turn('How much?',true);
 expect((await j.turn('Can I schedule an appointment?',true)).reply).toMatch(/details are saved/);
 await j.turn('970 Sidney Marcus Atlanta GA 30324',true);
 await j.turn('next Tuesday afternoon',true);
 expect((await j.turn('How much?',true)).reply).toMatch(/approved estimate/);
 expect(j.lead().address).toContain('30324'); expect(j.lead().preferredAppointmentTime).toContain('Tuesday');
 expect(j.conversation().serviceEligibility.reviewSubmitted).toBe(true);
 const keys=AlertService.create.mock.calls.map(([input])=>input.dedupeKey);
 expect(new Set(keys).size).toBe(1);
 expect(getAvailability).not.toHaveBeenCalled(); expect(AppointmentService.create).not.toHaveBeenCalled();
});
test.each(['sms','voice'])('%s new unsupported service invalidates offers but retains address',async channel=>{
 const j=journey(channel); await j.turn('I need faucet replacement',true); await j.turn('970 Sidney Marcus Atlanta GA 30324',true);
 await j.turn('What is available?',true);
 const result=await j.turn('Instead I need roof repair',true);
 expect(result.reply).toMatch(/does not offer/); expect(j.conversation().bookingState.status).toBe('not_started');
 expect(j.lead().address).toContain('30324'); expect(j.lead().serviceNeeded).toContain('roof');
});
test.each(['sms','voice'])('%s provider failure answers price without inventing an opening',async channel=>{
 const j=journey(channel); await j.turn('I need faucet replacement',true); await j.turn('970 Sidney Marcus Atlanta GA 30324',true);
 getAvailability.mockRejectedValue(new Error('provider unavailable'));
 const result=await j.turn('How much and when can you come fix it?',true);
 expect(result.reply).toContain('$100'); expect(result.reply).toMatch(/can’t verify live availability/);
 expect(result.reply).not.toMatch(/Current openings/); expect(AppointmentService.create).not.toHaveBeenCalled();
});
test.each(['sms','voice'])('%s ZIP correction clears offered times and preserves service',async channel=>{
 const j=journey(channel); await j.turn('I need faucet replacement',true); await j.turn('970 Sidney Marcus Atlanta GA 30324',true);
 await j.turn('What is available?',true); expect(j.conversation().bookingState.status).toBe('offering_slots');
 const result=await j.turn('No, the ZIP is 30326',true);
 expect(j.lead().address).toContain('30326'); expect(j.lead().address).not.toContain('30324');
 expect(j.lead().serviceNeeded).toContain('faucet'); expect(j.conversation().bookingState.offeredSlots || []).toHaveLength(0);
 expect(AppointmentService.create).not.toHaveBeenCalled(); expect(result.reply).not.toMatch(/can't verify that this business/);
});

test.each(trades)('%s callback interruption preserves compound facts through the real SMS reply pipeline', async (trade, request) => {
 services=[{...plumbing,_id:trade,name:trade==='garage_door'?'Garage door service':`${trade} service`,category:trade,keywords:[]}];
 const j=journey('sms');
 await j.turn(request,true);
 const result=await j.turn('Please call me. My address is 123 Main St, Atlanta GA 30303. Tomorrow at 3pm works.',true);
 expect(result.address).toContain('123 Main St');
 expect(result.preferredAppointmentTime).toContain('3:00 PM');
 expect(result.serviceNeeded).toBe(j.lead().serviceNeeded);
 expect(result.messageCategory).toBe('human_requested');
 expect(AppointmentService.create).not.toHaveBeenCalled();
});

test('a status question cannot bypass eligibility for a corrected, unsupported service', async () => {
 const j=journey('sms');
 await j.turn('I need faucet replacement',true);
 await j.turn('970 Sidney Marcus Atlanta GA 30324',true);
 await j.turn('What is available?',true);
 const result=await j.turn('Actually I need roof repair instead. Is my appointment confirmed?',true);
 expect(result.reply).toMatch(/does not offer/);
 expect(j.conversation().serviceEligibility.decision).toBe('unsupported');
 expect(j.conversation().bookingState.offeredSlots || []).toHaveLength(0);
 expect(AppointmentService.create).not.toHaveBeenCalled();
});

const compoundSelections = [
 'That time works for me. Please have someone call me at this number. Can you guarantee my appointment?',
 'Please call me. Option 1 works for me. Is the appointment confirmed?',
 'Can someone call me and confirm it? The first option works.',
 'Yes. Give me a call. Am I booked?',
];
test.each(trades.flatMap(([trade,request])=>compoundSelections.map(text=>({trade,request,text}))))(
 '$trade retains the offered preference and answers callback plus confirmation: $text', async ({trade,request,text})=>{
 services=[{...plumbing,_id:trade,name:trade==='garage_door'?'Garage door service':`${trade} service`,category:trade,keywords:[]}];
 const j=journey('sms'); await j.turn(request,true);
 if(trade==='restoration') await j.turn('The source is stopped',true);
 if(trade==='garage_door') await j.turn('The door is closed',true);
 await j.turn('970 Sidney Marcus Atlanta GA 30324',true);
 await j.turn('What is available?',true);
 const offered=j.conversation().bookingState.offeredSlots[0];
 const result=await j.turn(text,true);
 expect(result.compoundTurn).toBe(true);
 expect(result.reply).toMatch(/Requested/);
 expect(result.reply).toMatch(/not a confirmed appointment/i);
 expect(result.reply).toMatch(/Callback requested/);
 expect(j.lead().preferredAppointmentTime).toBe(result.preferredAppointmentTime);
 expect(j.conversation().conversationMemory.recoveryIntake.compoundTurn.selectedSlot.startAt).toEqual(offered.startAt);
 expect(AppointmentService.create).not.toHaveBeenCalled();
 expect(result.reply.length).toBeLessThanOrEqual(320);
});

test.each(trades.flatMap(([trade,request])=>['sms','voice'].map(channel=>({trade,request,channel}))))(
 '$channel $trade retains the primary request when additional work is queried', async ({trade,request,channel})=>{
 services=[{...plumbing,_id:trade,name:trade==='garage_door'?'Garage door service':`${trade} service`,category:trade,keywords:[]}];
 const j=journey(channel);await j.turn(request,true);await j.turn('970 Sidney Marcus Atlanta GA 30324',true);
 await j.turn('What is available?',true);
 const original=structuredClone(j.conversation());const originalLead=structuredClone(j.lead());
 const extra=trade==='roofing'?'faucet replacement':'roof repair';
 const result=await j.turn(`One more thing: can you also do ${extra}, or do I need another company? I still need the original work.`,true);
 expect(result.reply).toMatch(/request stays active/);
 expect(j.lead().serviceNeeded).toBe(originalLead.serviceNeeded);
 expect(j.lead().address).toBe(originalLead.address);
 expect(j.conversation().serviceEligibility).toEqual(original.serviceEligibility);
 expect(j.conversation().bookingState).toEqual(original.bookingState);
 const additional=j.conversation().conversationMemory.recoveryIntake.additionalRequests;
 expect(additional).toHaveLength(1);expect(additional[0].accepted).toBe(false);
 expect(AlertService.create).toHaveBeenCalledWith(expect.objectContaining({ title:'Additional service question', metadata:expect.objectContaining({primaryService:originalLead.serviceNeeded}) }));
 expect(AppointmentService.create).not.toHaveBeenCalled();
});

test('voice service replacement is checked before answering a confirmation question',async()=>{
 const lead={_id:'l',serviceNeeded:'faucet replacement',phone:'+14045550101',save:jest.fn()};
 const conversation={_id:'c',status:'open',conversationMemory:{},orchestration:{},bookingState:{status:'offering_slots',offeredSlots:[]},save:jest.fn()};
 const result=await VoiceAgent.handlePromptInternal({session:{_id:'v',business,lead,conversation,metadata:{},transcript:[]},customerMessage:'Instead I need roof repair. Is my appointment confirmed?',turnId:'replace'});
 expect(result.reply).toMatch(/does not offer/);expect(lead.serviceNeeded).toMatch(/roof/);
 expect(conversation.bookingState.status).toBe('not_started');
});
test('voice mixed selection and callback retains the chosen time and creates actionable handoff',async()=>{
 const start=new Date(Date.now()+3*86400000);
 const lead={_id:'l',serviceNeeded:'faucet replacement',phone:'+14045550101',address:'123 Main St Atlanta GA 30324',save:jest.fn()};
 const conversation={_id:'c',status:'open',conversationMemory:{},orchestration:{},bookingState:{status:'offering_slots',expiresAt:new Date(Date.now()+600000),offeredSlots:[{startAt:start,endAt:new Date(+start+3600000)}]},save:jest.fn()};
 const result=await VoiceAgent.handlePromptInternal({session:{_id:'v',business,lead,conversation,metadata:{},transcript:[]},customerMessage:'Option 1 works. Please call me. Is it confirmed?',turnId:'compound'});
 expect(result.reply).toMatch(/Requested/);expect(result.reply).toMatch(/Not a confirmed appointment/);
 expect(lead.preferredAppointmentTime).toBeTruthy();expect(VoiceCallback.handle).not.toHaveBeenCalled();
 expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({result:expect.objectContaining({preferredAppointmentTime:lead.preferredAppointmentTime})}));
 expect(conversation.orchestration.handoffReason).toBe('scheduling_review');
});

// Keep the real service-area policy in these channel journeys; only persistence
// is mocked. A missing fixture must never become implicit coverage permission.
test.each(['sms', 'voice'].flatMap(channel => [
 { channel, area: null, label: 'unconfigured', reply: /team.*review.*coverage/i },
 { channel, area: { type: 'zip_codes', zipCodes: ['30303'] }, label: 'outside coverage', reply: /outside.*service area/i },
]))('$channel blocks calendar reads for $label', async ({ channel, area, reply }) => {
 ServiceArea.findOne.mockReturnValue(query(area));
 const j = journey(channel);
 await j.turn('I need faucet replacement', true);
 const addressResult = await j.turn('123 Easy Street Bessemer AL 35022', true);
 expect(addressResult.reply).toMatch(reply);
 const result = await j.turn('What is available?', true);
 expect(result.reply).toMatch(reply);
 expect(getAvailability).not.toHaveBeenCalled();
 expect(AppointmentService.create).not.toHaveBeenCalled();
});

test.each(['sms', 'voice'])('%s rechecks coverage before refreshing previously offered times', async channel => {
 const j = journey(channel);
 await j.turn('I need faucet replacement', true);
 await j.turn('970 Sidney Marcus Atlanta GA 30324', true);
 await j.turn('What is available?', true);
 expect(j.conversation().bookingState.offeredSlots.length).toBeGreaterThan(0);
 getAvailability.mockClear();
 ServiceArea.findOne.mockReturnValue(query({ type: 'zip_codes', zipCodes: ['35022'] }));
 const result = await j.turn('What is available?', true);
 expect(result.reply).toMatch(/outside.*service area/i);
 expect(j.conversation().bookingState.offeredSlots || []).toHaveLength(0);
 expect(getAvailability).not.toHaveBeenCalled();
 expect(AppointmentService.create).not.toHaveBeenCalled();
});
