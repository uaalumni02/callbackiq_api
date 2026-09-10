import { generateAIReplyResult } from '../../src/services/aiReplyService.js';
import VoiceAgent from '../../src/voice/voiceAgent.service.js';
import Booking from '../../src/services/booking/bookingStateMachine.service.js';
import { parseTimePreference, findDateRange } from '../../src/services/booking/appointmentPreferenceParser.service.js';
import { classifySmsIntent } from '../../src/services/messaging/smsIntentClassifier.service.js';
import { filterAutomatedSlots } from '../../src/services/scheduling/automatedSchedulingPolicy.service.js';
import { constrainUncertainReply } from '../../src/services/messaging/uncertainReply.service.js';
import searchServices from '../../src/helpers/ai/tools/searchServices.tool.js';
import getAvailability from '../../src/helpers/ai/tools/getAvailability.tool.js';
import Alert from '../../src/services/alert.service.js';
import VoiceUnderstanding from '../../src/voice/voiceUnderstanding.service.js';
import { runWithVoiceTurnContext } from '../../src/services/voiceTurnContext.service.js';
import { resolveOpportunityValue } from '../../src/services/valuation/opportunityValue.js';
jest.mock('../../src/services/valuation/opportunityValuation.service.js', () => ({ beginValuation: jest.fn().mockResolvedValue(null), finishValuation: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/voice/voiceUnderstanding.service.js', () => ({ __esModule:true, default: { classifyVoiceTurn: jest.fn() } }));
jest.mock('../../src/services/businessReadiness.service.js',()=>({buildBusinessReadiness:jest.fn().mockResolvedValue({states:{bookingReady:true}})}));
jest.mock('../../src/services/communicationUsage.service.js',()=>({reserveAiUsage:jest.fn().mockResolvedValue({allowed:true})}));
jest.mock('../../src/helpers/ai/tools/searchServices.tool.js',()=>({__esModule:true,default:jest.fn()}));
jest.mock('../../src/helpers/ai/tools/getAvailability.tool.js',()=>({__esModule:true,default:jest.fn()}));
jest.mock('../../src/helpers/ai/tools/validateServiceArea.tool.js',()=>({__esModule:true,default:jest.fn().mockResolvedValue({supported:true})}));
jest.mock('../../src/services/alert.service.js',()=>({__esModule:true,default:{createSystemAlert:jest.fn(),createHumanHandoffAlert:jest.fn()}}));
jest.mock('../../src/voice/voiceCallback.service.js',()=>({__esModule:true,default:{isActive:jest.fn().mockReturnValue(false),handle:jest.fn()}}));
jest.mock('../../src/voice/voiceMetrics.service.js',()=>({__esModule:true,default:{recordVoiceMetric:jest.fn().mockResolvedValue({})}}));
const now = new Date('2026-09-09T22:10:00Z');
const timezone='America/New_York';
function context(id, channel='sms') {
 const business={_id:'business',businessName:'Atlanta Pro Plumbing & Drain',timezone,features:{aiBookingEnabled:false}};
 const lead={_id:'lead-'+id,phone:'+1404555010'+id,serviceNeeded:'Unknown',urgency:'medium',save:jest.fn().mockResolvedValue(null)};
 const conversation={_id:'conversation-'+id,status:'open',populate:jest.fn().mockResolvedValue(null),bookingState:{status:'not_started'},conversationMemory:{},save:jest.fn().mockResolvedValue(null),set(path,value){const [parent,key]=path.split('.');this[parent]??={};this[parent][key]=value;}};
 const session={_id:'session-'+id,business,lead,conversation,metadata:{},transcript:[],save:jest.fn().mockResolvedValue(null)};
 const messages=[];
 return {business,lead,conversation,session,async turn(body){messages.push({_id:String(messages.length+1),direction:'inbound',body});session.transcript.push({role:'customer',text:body});return channel==='voice'?VoiceAgent.handlePrompt({session,customerMessage:body,turnId:String(messages.length)}):generateAIReplyResult({business,lead,conversation,messages,customerMessage:body});}};
}
beforeEach(()=>{
 jest.clearAllMocks();jest.useFakeTimers().setSystemTime(now);
 searchServices.mockImplementation(async({query})=>[{id:query.includes('sink')?'sink':'toilet',name:query.includes('sink')?'Sink clearing':'Toilet clearing',score:1}]);
 getAvailability.mockImplementation(async ({ startDate, endDate }) => ({supportedServiceArea:true,slots: startDate <= '2026-09-11' && endDate >= '2026-09-11' ? [{startAt:'2026-09-11T13:00:00Z',endAt:'2026-09-11T14:00:00Z'}] : []}));
 Alert.createSystemAlert.mockResolvedValue({_id:'alert'});Alert.createHumanHandoffAlert.mockResolvedValue({_id:'alert'});
 VoiceUnderstanding.classifyVoiceTurn.mockResolvedValue({confidence:85,language:'en',intent:'booking',entities:{},safety:{isEmergency:false},directedAbuse:false});
});
afterEach(()=>jest.useRealTimers());
test.each(['sms','voice'])('%s concurrently replays both customers with isolated state and policy-filtered offers',async channel=>{
 const a=context(1,channel),b=context(2,channel);
 for(const [left,right] of [['My toilet is clogged','My sink is clogged'],['No, just the toilet','No, just the sink'],['965 Sidney Marcus BLVD Atlanta Georgia 30324','970 Sidney Marcus blvd Atlanta, Ga 30324'],["What's available?","What's available?"]]){
  const responses=await Promise.all([a.turn(left),b.turn(right)]);
  for(const result of responses) expect(result.reply).not.toMatch(/need to repeat|needs to review your request|What day would you prefer.*preference only/);
 }
 expect(a.lead.address).toContain('965');expect(b.lead.address).toContain('970');
 expect(a.lead.serviceNeeded).toMatch(/toilet/);expect(b.lead.serviceNeeded).toMatch(/sink/);
 for(const c of [a,b]){
  expect(c.conversation.bookingState.offeredSlots.length).toBeGreaterThan(0);
  for(const slot of c.conversation.bookingState.offeredSlots)expect(new Date(slot.startAt).getTime()-now.getTime()).toBeGreaterThanOrEqual(86400000);
  expect(c.conversation.bookingState.status).toBe('offering_slots');
  expect(c.conversation.conversationMemory.uncertainTurns||0).toBe(0);
 }
 expect(Alert.createHumanHandoffAlert).not.toHaveBeenCalled();
});
test.each([['9p',1260],['9pm',1260],['9 p.m.',1260],['9a',540],['21:00',1260],['01:30',90]])('parses %s without treating date digits as time', (text,minutes)=>expect(parseTimePreference(text,timezone,now).exactMinutes).toBe(minutes));
test('date-only and clock ranges do not manufacture a single exact time',()=>{
 expect(parseTimePreference('2026-09-11',timezone,now).targetMinutes).toBeNull();
 const range=parseTimePreference('between 9 and 11 pm',timezone,now);expect(range.exactMinutes).toBeNull();expect(range.windowStartMinutes).toBe(1260);expect(range.windowEndMinutes).toBe(1381);
 expect(findDateRange('Now',timezone,now)).toEqual({startDate:'2026-09-09',endDate:'2026-09-09'});
 expect(parseTimePreference('not now',timezone,now).targetMinutes).toBeNull();
});
test.each(["What's available?",'What is open?','Can you do today?','Could you do tomorrow?'])('routes %s to availability',text=>expect(classifySmsIntent({customerMessage:text}).intents.availabilityInquiry).toBe(true));
test('option freshness uses elapsed time across DST and rejects malformed slots',()=>{
 const epoch=new Date('2026-11-01T04:30:00Z');
 const slot=delta=>({startAt:new Date(+epoch+delta),endAt:new Date(+epoch+delta+3600000)});
 expect(filterAutomatedSlots([slot(-1),slot(0),slot(1),slot(3600000),{startAt:'bad',endAt:'bad'}],epoch)).toEqual([slot(1),slot(3600000)]);
 expect(()=>filterAutomatedSlots(undefined,epoch)).toThrow(/invalid availability/);
});
test('successful deterministic intake resets uncertainty before another unclear turn',async()=>{
 const c=context(1);await c.turn('My faucet needs resealing');
 c.conversation.conversationMemory.uncertainTurns=1;
 await c.turn('965 Sidney Marcus Blvd Atlanta GA 30324');
 expect(c.conversation.conversationMemory.uncertainTurns).toBe(0);
 const r=await constrainUncertainReply({result:{decision:'send',confidence:20},lead:c.lead,conversation:c.conversation,turnId:'new'});
 expect(r.actionType).toBe('request_information');
});
test('expired read-only options are refreshed and never submitted',async()=>{
 const c=context(1);c.lead.serviceNeeded='sink clearing';c.lead.address='970 Sidney Marcus Blvd Atlanta GA 30324';
 await c.turn("What's available?");c.conversation.bookingState.expiresAt=new Date(+now-1);
 const r=await c.turn('1');expect(r.reply).toMatch(/expired/);expect(Alert.createSystemAlert).not.toHaveBeenCalled();
});
test('negative time replies cannot select a slot',async()=>{
 const c=context(1);c.lead.serviceNeeded='sink clearing';await c.turn("What's available?");
 await c.turn('not 9 am');expect(Alert.createSystemAlert).not.toHaveBeenCalled();expect(c.conversation.bookingState.status).toBe('offering_slots');
});
test('failed availability and failed alert do not claim empty calendar or successful notification',async()=>{
 const c=context(1);c.lead.serviceNeeded='sink clearing';getAvailability.mockRejectedValue(new Error('503'));Alert.createSystemAlert.mockRejectedValue(new Error('database unavailable'));
 const r=await c.turn("What's available?");expect(r.reply).toMatch(/can’t verify/);expect(r.reply).not.toMatch(/alerted|no openings|no eligible/);
});
test('an interrupted voice turn cannot persist an availability offer',async()=>{
 const c=context(1);c.lead.serviceNeeded='sink clearing';const controller=new AbortController();
 searchServices.mockImplementation(async()=>{controller.abort();return [{id:'sink',name:'Sink clearing',score:1}];});
 await expect(runWithVoiceTurnContext({signal:controller.signal},()=>Booking.handle({...c,customerMessage:"What's available?",channel:'voice'}))).rejects.toMatchObject({code:'VOICE_STALE_TURN'});
 expect(c.conversation.save).not.toHaveBeenCalled();
});
test('both fixture values resolve independently; unknown has an explicit reason',()=>{
 const services=[{_id:'s1',business:'b',active:true,name:'Toilet clearing',keywords:['clogged toilet'],estimatedValue:225},{_id:'s2',business:'b',active:true,name:'Sink clearing',keywords:['clogged sink'],estimatedValue:175}];
 expect(resolveOpportunityValue({businessId:'b',services,evidence:'My toilet is clogged'}).estimatedValue).toBe(225);
 expect(resolveOpportunityValue({businessId:'b',services,evidence:'My sink is clogged'}).estimatedValue).toBe(175);
 expect(resolveOpportunityValue({businessId:'b',services,evidence:'roof damage'}).valuation.basis).toMatch(/No service-specific/);
});

test('invalid and excessive date ranges cannot launch an unbounded availability query',()=>{
 for (const text of ['2026-02-30 through 2026-03-02','2026-09-12 through 2026-09-09','2026-09-09 through 2099-09-09']) expect(findDateRange(text,timezone,now)).toBeNull();
});
test('short meridiem ranges preserve both bounds',()=>{
 const p=parseTimePreference('between 9p and 11p',timezone,now);expect(p.windowStartMinutes).toBe(1260);expect(p.windowEndMinutes).toBe(1381);expect(p.exactMinutes).toBeNull();
});

test.each(['sms','voice'])('%s routes an unavailable same-day request into staff review',async channel=>{
 const c=context(1,channel);
 await c.turn('My toilet is clogged'); await c.turn('No, just the toilet');
 await c.turn('965 Sidney Marcus BLVD Atlanta Georgia 30324');
 const result=await c.turn('Can you do today?');
 expect(result.reply).toMatch(/team review/);
 expect(result.reply).toMatch(/not a confirmed appointment/);
 expect(c.conversation.bookingState.offeredSlots).toEqual([]);
 if(channel==='voice') { expect(result.outcome).toBe('callback_saved'); expect(Alert.createHumanHandoffAlert).toHaveBeenCalled(); }
});
