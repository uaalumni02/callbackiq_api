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

import Alert from '../../src/models/alert.js';
jest.mock('../../src/models/alert.js',()=>({__esModule:true,default:{findOneAndUpdate:jest.fn()}}));
jest.mock('../../src/services/socket.service.js',()=>({__esModule:true,default:new Proxy({},{get:()=>jest.fn()})}));


let services, policy;
const plumbing = { _id: 'plumbing', business: 'b', active: true, name: 'Plumbing service', category: 'plumbing', aiCanDiscuss: true, aiCanBook: true, keywords: ['repair', 'install', 'leak'], disclosePriceEstimate: true, priceEstimateMin: 100, priceEstimateMax: 200 };
const business = { _id: 'b', businessName: 'Plumbing Co', timezone: 'America/New_York', features: { aiBookingEnabled: true } };
const query = value => ({ lean: jest.fn(async () => value), select() { return this; } });
const durable = initial => {
  let saved = JSON.parse(JSON.stringify(initial));
  return { read() { return { ...structuredClone(saved), set(path, value) { const keys=path.split('.'); let target=this; for(const key of keys.slice(0,-1)) target=target[key] ||= {}; target[keys.at(-1)]=value; }, markModified() {}, async populate() { return this; }, async save() { saved = JSON.parse(JSON.stringify(this)); } }; }, snapshot() { return saved; } };
};
function journey(channel = 'sms', seed = {}) {
  const l = durable({ _id: 'l', business: 'b', serviceNeeded: 'Unknown', phone: '+14045550101', urgency: 'low', estimatedValue: 999, valuation: { source: 'service_catalog' }, qualifiedAt: '2026-01-01', ...seed.lead });
  const c = durable({ _id: 'c', business: 'b', lead: 'l', status: 'open', customerPhone: '+14045550101', bookingState: { status: 'not_started' }, conversationMemory: {}, orchestration: {}, ...seed.conversation });
  let n = 0; const history=[];
  const session={_id:'v', from:'+14045550101', to:'+14045550100', business, metadata:{}, transcript:[], save:jest.fn().mockResolvedValue(null)};
  return { lead:l.snapshot, conversation:c.snapshot, session, async turn(text, throughChannel=false) {
    jest.setSystemTime(new Date(Date.now()+15000));
    const lead=l.read(), conversation=c.read();
    history.push({_id:`m${++n}`,direction:'inbound',body:text,createdAt:new Date()});
    Object.assign(session,{lead,conversation});
    session.transcript.push({role:'customer',text,at:new Date()});
    Lead.findOne.mockReturnValue(query(lead)); Conversation.findOne.mockReturnValue(query(conversation));
    const result=channel==='voice' ? await VoiceAgent.handlePrompt({session,customerMessage:text,turnId:`v${n}`})
      : await generateAIReplyResult({business,lead,conversation,customerMessage:text,messages:history});
    if(result?.reply){session.transcript.push({role:'assistant',text:result.reply,at:new Date()});history.push({_id:`m${++n}`,direction:'outbound',body:result.reply,createdAt:new Date()});}
    return result;
  } };
}
beforeEach(() => {
  jest.clearAllMocks(); business.features.aiBookingEnabled = false; business.features.missedCallSmsEnabled = false; services = [plumbing]; policy = { catalogComplete: true };
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
  jest.spyOn(VoiceCallback,'handle');
  Alert.findOneAndUpdate.mockResolvedValue({_id:'safety-alert'});
});

jest.mock('../../src/helpers/ai/tools/getAvailability.tool.js',()=>({__esModule:true,default:jest.fn()}));

import fs from 'node:fs';
import path from 'node:path';
const records=[];
beforeEach(()=>{
 jest.useFakeTimers({doNotFake:['nextTick','queueMicrotask','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','hrtime','performance']}); jest.setSystemTime(new Date('2026-09-23T14:00:00Z'));
 getAvailability.mockResolvedValue({supportedServiceArea:true,slots:[{startAt:'2026-09-25T14:00:00Z',endAt:'2026-09-25T15:00:00Z'},{startAt:'2026-09-25T18:00:00Z',endAt:'2026-09-25T19:00:00Z'}]});
});
afterEach(()=>{jest.useRealTimers();jest.restoreAllMocks();});
afterAll(()=>{ if(process.env.VOICE_SIM_OUTPUT) { fs.mkdirSync(process.env.VOICE_SIM_OUTPUT,{recursive:true}); fs.writeFileSync(path.join(process.env.VOICE_SIM_OUTPUT,'adversarial-transcripts.json'),JSON.stringify(records,null,2)); } });

const start=['My kitchen sink needs replacement','970 Sidney Marcus Atlanta GA 30324'];
const noBooking=()=>{expect(AppointmentService.create).not.toHaveBeenCalled();expect(createAppointment).not.toHaveBeenCalled();};
const scenarios=[
 {name:'Long journey: service, address, ZIP, price, two time corrections and callback',turns:[...start,'Actually, the bathroom sink, not the kitchen sink','Correction, the address is 123 Main Street Atlanta GA 30303','No, the ZIP is 30326','How much will it cost?','Friday at 10 am','Actually make that 2 pm','What times are available?','Option 2 works. Please call me. Is it confirmed?'],check:(j,r)=>{expect(j.lead().serviceNeeded).toBe('bathroom sink needs replacement');expect(j.lead().address).toBe('123 Main Street Atlanta GA 30326');expect(j.lead().preferredAppointmentTime).toBe('Fri, Sep 25, 2:00 PM');expect(r.at(-1).reply).toMatch(/not.*confirmed/i);noBooking();}},
 {name:'Repeated fixture corrections keep replacement scope and address',turns:[...start,'Actually, the bathroom sink, not the kitchen sink','Actually, the laundry sink, not the bathroom sink','Not the laundry sink, but the kitchen sink','Friday at 2 pm','Please call me instead'],check:(j,r)=>{expect(r.at(-1).reply).not.toMatch(/What do you need help with/i);expect(j.lead().serviceNeeded).toBe('kitchen sink needs replacement');expect(j.lead().address).toBe('970 Sidney Marcus Atlanta GA 30324');expect(j.lead().preferredAppointmentTime).toMatch(/14:00|2:00 PM/);noBooking();}},
 {name:'Contradictory numbered options must not silently select one',turns:[...start,'What times are available?','Option 1 works, actually option 2. Please call me. Is it confirmed?'],check:(j,r)=>{const selected=j.conversation().conversationMemory?.recoveryIntake?.compoundTurn?.selectedSlot;expect(selected).toBeNull();expect(j.lead().preferredAppointmentTime||'').toBe('');expect(r.at(-1).reply).toMatch(/which|clarif|prefer/i);noBooking();}},
 {name:'Rejected option plus callback cannot be booked or recorded as accepted',turns:[...start,'What times are available?','Do not select option 1. Neither time works. Please call me.'],check:j=>{expect(j.lead().preferredAppointmentTime||'').toBe('');noBooking();}},
 {name:'Stale offers cannot be selected after one hour',turns:[...start,'What times are available?',{advance:3600000,text:'Option 1 works. Please call me. Is it confirmed?'}],check:(j,r)=>{expect(r.at(-1).reply).toMatch(/expired|recheck/i);expect(j.lead().preferredAppointmentTime||'').toBe('');noBooking();}},
 {name:'Address moves outside coverage after offers, then old option is requested',turns:[...start,'What times are available?','Correction, the address is 123 Easy Street Bessemer AL 35022','Option 1 works. Please call me. Is it confirmed?'],check:(j,r)=>{expect(j.lead().address).toContain('35022');expect(j.conversation().bookingState.offeredSlots||[]).toHaveLength(0);expect(j.lead().preferredAppointmentTime||'').toBe('');expect(r.at(-1).reply).not.toMatch(/Requested Fri|you.re booked/i);noBooking();}},
 {name:'Unsupported additional job cannot replace the original accepted request',turns:[...start,'Friday at 10 am','Also I need my roof repaired','What about the sink appointment?','Please call me'],check:j=>{expect(j.lead().serviceNeeded).toMatch(/sink/i);expect(j.lead().serviceNeeded).not.toMatch(/roof/i);expect(j.lead().address).toContain('30324');noBooking();}},
 {name:'No leak -> active leak -> uncontrolled flooding must escalate',turns:['My kitchen sink is clogged but there is no leaking or flooding','No, only the kitchen sink','970 Sidney Marcus Atlanta GA 30324','Friday at 2 pm','Actually it is leaking continuously now','I cannot turn the water off and water is now pouring across the floor'],check:(j,r)=>{expect((j.lead().serviceNeeded.match(/it is leaking continuously now/g)||[]).length).toBeLessThanOrEqual(1);expect(j.lead().urgency).toBe('emergency');expect(r.at(-1).reply).toMatch(/911|nine one one/i);expect(r.at(-1).reply).toMatch(/does not monitor emergencies or dispatch emergency help/);expect(Alert.findOneAndUpdate).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({$setOnInsert:expect.objectContaining({priority:'critical'})}),expect.anything());noBooking();}},
 {name:'Hazard negation followed by affirmative gas must not suppress emergency',turns:[...start,'There is no flooding, but I smell gas and feel dizzy'],check:(j,r)=>{expect(j.lead().urgency).toBe('emergency');expect(r.at(-1).reply).toMatch(/911|nine one one/i);expect(r.at(-1).reply).not.toMatch(/technician is on the way|dispatching/);}},
 {name:'Direct-agent alert-write failure is propagated (relay safety guard tested separately)',turns:[...start,{fault:'alert',text:'I smell gas and feel dizzy'}],check:(j,r)=>{expect(r.at(-1).error).toBe('injected alert write failure');expect(r.at(-1).reply||'').not.toMatch(/team (?:was|has been) notified|saved for review/i);}},
 {name:'Calendar outage after an earlier offer must not present stale availability',turns:[...start,'What times are available?',{fault:'calendar',text:'Check again, what times are available now?'}],check:(j,r)=>{expect(r.at(-1).reply).toMatch(/can.t verify|unable|unavailable|trouble/i);expect(r.at(-1).reply).not.toMatch(/Current openings/);noBooking();}},
 {name:'Staff-review failure on accepted option must not claim request sent',turns:[...start,'What times are available?',{fault:'handoff',text:'Option 2 works. Please call me. Is it confirmed?'}],check:(j,r)=>{const last=r.at(-1);expect(last.error||last.reply).toBeTruthy();expect(last.reply||'').not.toMatch(/request (?:was |is )?saved|sent for review|team (?:was|has been) notified/i);noBooking();}},
 {name:'Unanswered clog question must remain unresolved through scheduling',turns:['My kitchen sink is clogged but there is no leaking or flooding','970 Sidney Marcus Atlanta GA 30324','Friday at 10 am','Is it confirmed?'],check:(j,r)=>{const state=j.conversation().conversationMemory.recoveryIntake;expect(state.clogResolved).not.toBe(true);expect(state.clogPending).toBe(true);expect(r.at(-1).reply).toMatch(/No appointment is confirmed|not.*confirmed/i);expect(r.at(-1).reply).not.toMatch(/you.re booked/i);noBooking();}},
 {name:'Pronoun pricing question cannot overwrite established service',turns:[...start,'How much to fix it?','Can you repair that instead?','What would fixing the same problem cost?','Friday at 2 pm'],check:j=>{expect(j.lead().serviceNeeded).toMatch(/sink/i);expect(j.lead().serviceNeeded).not.toMatch(/same problem|fix it|repair that/i);expect(j.lead().address).toContain('30324');noBooking();}},
 {name:'Repeat question reproduces the preceding assistant question',turns:['My kitchen sink needs replacement','Could you repeat that?'],check:(j,r)=>{expect(r[1].reply).toContain('What is the service address?');expect(j.lead().serviceNeeded).toBe('kitchen sink needs replacement');}},
 {name:'Unclear caller recovers without inventing a service',turns:['The thing is doing it again','You know, the thing downstairs','Actually I need my kitchen faucet replaced','970 Sidney Marcus Atlanta GA 30324','Friday at 10 am','Yes'],check:j=>{expect(j.lead().serviceNeeded).toMatch(/faucet/i);expect(j.lead().serviceNeeded).not.toMatch(/thing downstairs|unknown/i);expect(j.lead().address).toContain('30324');}},
];
test.each(scenarios)('$name',async scenario=>{
 const j=journey('voice');const replies=[];const record={name:scenario.name,turns:[]};records.push(record);
 for(const input of scenario.turns){
  const item=typeof input==='string'?{text:input}:input;
  if(item.advance)jest.setSystemTime(new Date(Date.now()+item.advance));
  if(item.fault==='calendar')getAvailability.mockRejectedValue(new Error('injected calendar failure'));
  if(item.fault==='alert')Alert.findOneAndUpdate.mockRejectedValueOnce(new Error('injected alert write failure'));
  if(item.fault==='handoff')AlertService.createHumanHandoffAlert.mockRejectedValueOnce(new Error('injected handoff write failure'));
  let result;
  try {result=await j.turn(item.text,true);}catch(error){result={error:error.message};}
  replies.push(result);record.turns.push({customer:item.text,result,lead:structuredClone(j.lead()),conversation:structuredClone(j.conversation())});
 }
 try {scenario.check(j,replies);record.status='passed';}catch(error){record.status='failed';record.failure=error.message;throw error;}
});


test('triage answers remain separate from service summaries through repeat and escalation', async () => {
 const j=journey('voice');
 await j.turn('My kitchen sink is clogged but there is no leaking or flooding');
 await j.turn('No, only the kitchen sink');
 await j.turn('No, only the kitchen sink');
 expect(j.lead().serviceNeeded).toMatch(/kitchen sink.*clogged/i);
 expect(j.conversation().conversationMemory.recoveryIntake.serviceDetail).not.toMatch(/^No, only/i);
 await j.turn('Actually it is leaking continuously now');
 const result=await j.turn('I cannot turn the water off and water is now pouring across the floor');
 expect({urgency:j.lead().urgency,duplicates:(j.lead().serviceNeeded.match(/leaking continuously now/g)||[]).length,safetyReply:/911|nine one one/i.test(result.reply),critical:Alert.findOneAndUpdate.mock.calls.some(([,update])=>update.$setOnInsert?.priority==='critical')}).toEqual({urgency:'emergency',duplicates:1,safetyReply:true,critical:true});
});

test('unclear caller completes corrected callback with exact durable facts and alert payload', async () => {
 const j=journey('voice');
 const record={name:'Unclear caller through corrected readback, confirmation and handoff',turns:[]};records.push(record);
 for(const text of ['The thing is doing it again','You know, the thing downstairs','Actually I need my kitchen faucet replaced','970 Sidney Marcus Atlanta GA 30324','Friday at 10 am','Pat Smith','Yes']) {
  const result=await j.turn(text);record.turns.push({customer:text,result,lead:structuredClone(j.lead()),conversation:structuredClone(j.conversation())});
 }
 expect(record.turns.at(-1).result.callbackCaptured).toBe(true);
 expect(j.lead()).toMatchObject({customerName:'Pat Smith',serviceNeeded:'my kitchen faucet replaced',address:'970 Sidney Marcus Atlanta GA 30324',preferredAppointmentTime:'Friday at 10 am'});
 expect(Alert.findOneAndUpdate).toHaveBeenCalledTimes(1);
 expect(Alert.findOneAndUpdate.mock.calls[0][1].$setOnInsert.metadata.callbackDetails).toMatchObject({serviceNeeded:'my kitchen faucet replaced',customerName:'Pat Smith',location:'970 Sidney Marcus Atlanta GA 30324',preferredTime:'Friday at 10 am'});
 record.status='passed';
});


jest.mock('../../src/helpers/ai/tools/createAppointment.tool.js',()=>({__esModule:true,default:jest.fn()}));
jest.mock('../../src/services/businessReadiness.service.js',()=>({buildBusinessReadiness:jest.fn().mockResolvedValue({states:{bookingReady:true,bookingConfigurationReady:true},missingRequirements:{booking:[]}})}));
test('real voice agent with booking enabled offers, selects, and submits exact slot for business approval',async()=>{
 business.features.aiBookingEnabled=true;
 const j=journey('voice',{lead:{customerName:'Pat Smith',serviceNeeded:'Kitchen sink replacement',address:'970 Sidney Marcus Atlanta GA 30324'},conversation:{bookingState:{status:'collecting_preference',serviceOffering:'plumbing',streetAddress:'970 Sidney Marcus Atlanta GA',postalCode:'30324',availabilityInquiry:true,offeredSlots:[]}}});
 const record={name:'Booking enabled: offer, selection, and held appointment',turns:[]};records.push(record);
 const turn=async text=>{const result=await j.turn(text);record.turns.push({customer:text,result,lead:structuredClone(j.lead()),conversation:structuredClone(j.conversation())});return result;};
 await turn('What times are available?');
 expect(j.conversation().bookingState.status).toBe('offering_slots');
 const chosen=j.conversation().bookingState.offeredSlots[1];
 await turn('Option 2');
 expect(j.conversation().bookingState.status).toBe('awaiting_confirmation');
 expect(createAppointment).not.toHaveBeenCalled();
 createAppointment.mockResolvedValue({_id:'held-voice',status:'held',requiresBusinessApproval:true,heldExpiresAt:new Date('2026-09-23T15:00:00Z'),startAt:chosen.startAt,endAt:chosen.endAt,timezone:'America/New_York'});
 const result=await turn('Yes');
 expect(createAppointment).toHaveBeenCalledTimes(1);
 expect(new Date(createAppointment.mock.calls[0][0].input.startAt).toISOString()).toBe('2026-09-25T18:00:00.000Z');
 expect(j.conversation().bookingState).toMatchObject({status:'pending_business_confirmation',appointment:'held-voice'});
 expect(result.reply).toMatch(/not confirmed until the team accepts/i);
 record.status='passed';
});
jest.mock('../../src/services/automation/automationTrigger.service.js',()=>({__esModule:true,default:{schedule:jest.fn()}}));
jest.mock('../../src/services/conversionEvent.service.js',()=>({__esModule:true,default:{record:jest.fn()}}));
