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
function journey(channel = 'sms') {
  const l = durable({ _id: 'l', business: 'b', serviceNeeded: 'Unknown', phone: '+14045550101', urgency: 'low', estimatedValue: 999, valuation: { source: 'service_catalog' }, qualifiedAt: '2026-01-01' });
  const c = durable({ _id: 'c', business: 'b', lead: 'l', status: 'open', customerPhone: '+14045550101', bookingState: { status: 'not_started' }, conversationMemory: {}, orchestration: {} });
  let n = 0; const history=[];
  const session={_id:'v', business, metadata:{}, transcript:[], save:jest.fn().mockResolvedValue(null)};
  return { lead:l.snapshot, conversation:c.snapshot, session, async turn(text, throughChannel=false) {
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
  jest.spyOn(VoiceCallback,'handle');
  Alert.findOneAndUpdate.mockResolvedValue({_id:'safety-alert'});
});

jest.mock('../../src/helpers/ai/tools/getAvailability.tool.js',()=>({__esModule:true,default:jest.fn()}));

import fs from 'node:fs';
import path from 'node:path';
const records=[];
beforeEach(()=>{
 jest.useFakeTimers({doNotFake:['nextTick','queueMicrotask','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','hrtime','performance']}); jest.setSystemTime(new Date('2026-09-23T14:00:00Z'));
 getAvailability.mockResolvedValue({supportedServiceArea:true,slots:[{startAt:'2026-09-25T14:00:00Z',endAt:'2026-09-25T15:00:00Z'}]});
});
afterEach(()=>{jest.useRealTimers();jest.restoreAllMocks();});
afterAll(()=>{ if(process.env.VOICE_SIM_OUTPUT) { fs.mkdirSync(process.env.VOICE_SIM_OUTPUT,{recursive:true}); fs.writeFileSync(path.join(process.env.VOICE_SIM_OUTPUT,'customer-transcripts.json'),JSON.stringify(records,null,2)); } });
const cases=[
 {name:'Service correction retains location', turns:['My kitchen sink needs replacement','970 Sidney Marcus Atlanta GA 30324','Actually, the bathroom sink, not the kitchen sink','Friday at 10 am'], check:j=>{expect(j.lead().serviceNeeded).toMatch(/bathroom sink/i);expect(j.lead().serviceNeeded).not.toMatch(/kitchen|not the bathroom/i);expect(j.lead().address).toContain('970 Sidney Marcus');}},
 {name:'Address correction replaces previous address', turns:['I need faucet replacement','970 Sidney Marcus Atlanta GA 30324','Correction, the address is 123 Main Street Atlanta GA 30303','Friday at 10 am'],check:j=>{expect(j.lead().address).toContain('123 Main');expect(j.lead().address).not.toContain('970');}},
 {name:'Ambiguous broken fixture requires clarification', turns:['My toilet is broken'],check:(j,r)=>{expect(r[0].reply).toMatch(/leak|clog|flush|what.*(?:wrong|happen)|tell me/i);expect(AppointmentService.create).not.toHaveBeenCalled();}},
 {name:'Negated flooding does not escalate',turns:['My kitchen sink is clogged but there is no leaking or flooding','970 Sidney Marcus Atlanta GA 30324'],check:(j,r)=>{expect(r[0].reply).not.toMatch(/is (?:the sink|water) leaking/i);expect(j.lead().urgency).not.toBe('emergency');expect(VoiceCallback.handle).not.toHaveBeenCalled();}},
 {name:'Active flooding overrides earlier negation',turns:['My kitchen sink is clogged','No flooding before, but water is now pouring across the kitchen floor'],check:(j,r)=>{expect(j.lead().urgency).toBe('emergency');expect(r.at(-1).reply).toMatch(/911|nine one one/i);expect(r.at(-1).reply).toMatch(/does not monitor emergencies or dispatch emergency help/i);expect(Alert.findOneAndUpdate).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({$setOnInsert:expect.objectContaining({type:'safety_emergency',priority:'critical',actionRequired:true})}),expect.anything());}},
 {name:'Offered time plus callback and confirmation question',turns:['I need faucet replacement','970 Sidney Marcus Atlanta GA 30324','What times are available?','Option 1 works. Please call me. Is it confirmed?'],check:(j,r)=>{expect(j.lead().preferredAppointmentTime).toBe('Fri, Sep 25, 10:00 AM');expect(r.at(-1).reply).toMatch(/not.*confirmed/i);expect(AlertService.createHumanHandoffAlert).toHaveBeenCalled();expect(AppointmentService.create).not.toHaveBeenCalled();expect(r[2].reply).not.toMatch(/a\.m\. AM|p\.m\. PM/);}},
 {name:'Same-day request cannot become automatic booking',turns:['I need faucet replacement','970 Sidney Marcus Atlanta GA 30324','Can you come today at 3 pm?'],check:(j,r)=>{expect(j.lead().preferredAppointmentTime).toBe('2026-09-23 at 15:00');expect(r.at(-1).reply).toMatch(/not a confirmed appointment or dispatch/i);expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({result:expect.objectContaining({preferredAppointmentTime:'2026-09-23 at 15:00'})}));expect(AppointmentService.create).not.toHaveBeenCalled();}},
 {name:'Calendar outage cannot invent opening',outage:true,turns:['I need faucet replacement','970 Sidney Marcus Atlanta GA 30324','How much and when can you come?'],check:(j,r)=>{expect(r.at(-1).reply).toMatch(/can.t verify|unavailable|trouble|unable/i);expect(r.at(-1).reply).not.toMatch(/Current openings/);}},
 {name:'Unsupported service invalidates prior offers',turns:['I need faucet replacement','970 Sidney Marcus Atlanta GA 30324','What times are available?','Instead I need roof repair'],check:(j,r)=>{expect(r.at(-1).reply).toMatch(/does not offer/i);expect(j.conversation().bookingState.offeredSlots||[]).toHaveLength(0);}},
 {name:'Time correction keeps selected day',turns:['I need faucet replacement','970 Sidney Marcus Atlanta GA 30324','Friday at 10 am','Actually make that 2 pm'],check:j=>{expect(j.lead().preferredAppointmentTime).toMatch(/14:00|2.*pm/i);expect(j.lead().preferredAppointmentTime).toMatch(/2026-09-25|Friday/i);}},
];
test.each(cases)('$name',async scenario=>{
 if(scenario.outage)getAvailability.mockRejectedValue(new Error('simulated calendar outage'));
 const j=journey('voice');const replies=[];const record={name:scenario.name,turns:[],limitations:['JSON snapshot persistence, not MongoDB','No OpenAI API key; real deterministic understanding','Calendar and alert persistence are doubles; callback service is real']};records.push(record);
 for(const text of scenario.turns){const result=await j.turn(text,true);replies.push(result);record.turns.push({customer:text,reply:result?.reply,result,lead:structuredClone(j.lead()),conversation:structuredClone(j.conversation())});}
 record.callbackCalls=VoiceCallback.handle.mock.calls.map(([x])=>({reason:x.reason,priority:x.priority,immediate:x.immediate}));
 try {scenario.check(j,replies);record.status='passed';}catch(error){record.status='failed';record.failure=error.message;throw error;}
});

test.each(['sms','voice'].flatMap(channel=>[
 ['plumbing','kitchen sink','bathroom sink'],['hvac','furnace','air conditioner'],['locksmith','front door lock','back door lock'],['garage_door','garage door','garage door opener']
].map(([trade,old,next])=>({channel,trade,old,next}))))('$channel $trade correction survives repeated interpretation and reload',async({channel,trade,old,next})=>{
 services=[{...plumbing,_id:trade,name:`${trade} service`,category:trade,keywords:[]}];
 const j=journey(channel);
 await j.turn(`My ${old} needs replacement`,true);
 await j.turn('970 Sidney Marcus Atlanta GA 30324',true);
 for(let i=0;i<2;i++){
  await j.turn(`Actually, the ${next}, not the ${old}`,true);
  expect(j.lead().serviceNeeded).toBe(`${next} needs replacement`);
  expect(j.lead().address).toBe('970 Sidney Marcus Atlanta GA 30324');
 }
 expect(AppointmentService.create).not.toHaveBeenCalled();
});
test.each(['no leaking','no leaks','not leaking','no longer leaking','not currently leaking'])('explicit condition survives later address turn: %s',async condition=>{
 const j=journey('voice');
 const first=await j.turn(`My kitchen sink is clogged but there is ${condition}`,true);
 const next=await j.turn('970 Sidney Marcus Atlanta GA 30324',true);
 expect(`${first.reply} ${next.reply}`).not.toMatch(/is (?:the sink|water) leaking/i);
 expect(j.lead().urgency).not.toBe('emergency');
});
test('a failed scheduling handoff cannot return a saved acknowledgment',async()=>{
 const j=journey('voice');await j.turn('I need faucet replacement',true);await j.turn('970 Sidney Marcus Atlanta GA 30324',true);
 AlertService.createHumanHandoffAlert.mockRejectedValueOnce(new Error('handoff persistence failed'));
 const result=await j.turn('Can you come today at 3 pm?',true);
 expect(result.reply).toMatch(/needs team review|unable|could not|can.t/i);
 expect(result.reply).not.toMatch(/request (?:was |is )?saved|sent for review|team (?:was |has been )?notified|you.re booked/i);
 expect(result.outcome).not.toBe('callback_saved');
});
