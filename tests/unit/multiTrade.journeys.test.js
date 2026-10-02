import { multiTradeCases, testOffering } from '../fixtures/multiTradeCases.js';
import { handleRecoveryIntake } from '../../src/services/booking/recoveryIntake.service.js';
import { assertServiceRequestEligible } from '../../src/services/serviceEligibility/serviceEligibility.service.js';
import { classifySmsIntent } from '../../src/services/messaging/smsIntentClassifier.service.js';
import { smsContactControlKind, contactControlReply } from '../../src/services/messaging/smsContactControl.service.js';
import { assessInboundSafety } from '../../src/services/safetyAssessmentService.js';
import ServiceOffering from '../../src/models/serviceOffering.js';
import Operations from '../../src/models/businessOperationsSettings.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import getAvailability from '../../src/helpers/ai/tools/getAvailability.tool.js';
import validateServiceArea from '../../src/helpers/ai/tools/validateServiceArea.tool.js';
import AlertService from '../../src/services/alert.service.js';
import { getApprovedServiceEstimate } from '../../src/services/booking/approvedServiceEstimate.service.js';
jest.mock('../../src/models/serviceOffering.js',()=>({__esModule:true,default:{find:jest.fn()}}));
jest.mock('../../src/models/businessOperationsSettings.js',()=>({__esModule:true,default:{findOne:jest.fn()}}));
jest.mock('../../src/models/lead.js',()=>({__esModule:true,default:{findOne:jest.fn()}}));
jest.mock('../../src/models/conversation.js',()=>({__esModule:true,default:{findOne:jest.fn()}}));
jest.mock('../../src/helpers/ai/tools/getAvailability.tool.js',()=>({__esModule:true,default:jest.fn()}));
jest.mock('../../src/helpers/ai/tools/validateServiceArea.tool.js',()=>({__esModule:true,default:jest.fn()}));
jest.mock('../../src/services/alert.service.js',()=>({__esModule:true,default:{createHumanHandoffAlert:jest.fn(),create:jest.fn()}}));
jest.mock('../../src/services/booking/approvedServiceEstimate.service.js',()=>({getApprovedServiceEstimate:jest.fn()}));
const query=value=>({lean:jest.fn().mockResolvedValue(value),select(){return this;}});
const address='87 Oak Lane Marietta GA 30060';
const now=new Date('2026-10-01T14:00:00Z');
const slots=[{startAt:'2026-10-06T14:00:00Z',endAt:'2026-10-06T15:30:00Z'}];
let services;
function context(row,channel){
 services=[testOffering(row)];
 const lead={_id:'l1',phone:'+14045550101',serviceNeeded:'Unknown',urgency:'medium',save:jest.fn().mockResolvedValue(null)};
 const conversation={_id:'c1',status:'open',bookingState:{status:'not_started'},conversationMemory:{},save:jest.fn().mockResolvedValue(null),markModified(){}};
 const business={_id:'b1',businessName:`Test ${row.trade}`,businessType:row.trade,timezone:'America/New_York',features:{aiBookingEnabled:false}};
 let turnId=0;
 const c={lead,conversation,business,channel,session:{_id:'v1'},now};
 c.turn=text=>handleRecoveryIntake({...c,customerMessage:text,turnId:`turn-${++turnId}`});
 c.start=async()=>{await c.turn(row.request);for(const answer of row.answers) await c.turn(answer);};
 Lead.findOne.mockImplementation(()=>query(lead)); Conversation.findOne.mockImplementation(()=>query(conversation));
 return c;
}
beforeEach(()=>{
 jest.clearAllMocks();
 ServiceOffering.find.mockImplementation(()=>query(services));
 Operations.findOne.mockImplementation(()=>query({serviceEligibilityPolicy:{catalogComplete:true}}));
 getAvailability.mockResolvedValue({supportedServiceArea:true,slots}); validateServiceArea.mockResolvedValue({supported:true});
 getApprovedServiceEstimate.mockResolvedValue('');
 AlertService.createHumanHandoffAlert.mockResolvedValue({alert:{_id:'review'}}); AlertService.create.mockResolvedValue({alert:{_id:'review'}});
});
describe.each(['sms','voice'])('%s all-trade journeys',channel=>{
 test.each(multiTradeCases)('$trade collects facts, qualifies, preserves corrections and queues an unconfirmed request',async row=>{
  const c=context(row,channel);await c.start(); await c.turn(address); await c.turn('October 6 at 10 am');
  expect(c.lead.address).toBe(address);expect(c.lead.preferredAppointmentTime).toMatch(/2026-10-06.*10/);
  expect(c.conversation.conversationMemory.recoveryIntake.tradeQualification.status).toBe('clear');
  expect(c.conversation.bookingState.status).toBe('not_started');
  expect(getAvailability).toHaveBeenCalled();
  const result=await c.turn('Is my appointment confirmed?');expect(result.reply).toMatch(/not confirmed|not a confirmed|approval|review/i);
  const service=c.lead.serviceNeeded;await c.turn('Correction, the address is 123 Main Street Atlanta GA 30324');
  expect(c.lead.address).toContain('123 Main Street');expect(c.lead.serviceNeeded).toBe(service);
 });
 test.each(multiTradeCases)('$trade unknown availability is never presented as booked',async row=>{
  const c=context(row,channel);await c.start();await c.turn(address);getAvailability.mockRejectedValue(new Error('provider unavailable'));
  const result=await c.turn('October 6 at 10 am');
  expect(c.conversation.conversationMemory.recoveryIntake.availability.status).toBe('check_failed');
  expect(result.intakeCompletionReply || result.reply).toMatch(/could not|couldn't|needs.*review/i);
  expect(c.conversation.bookingState.appointment).toBeUndefined();
 });
 test.each(multiTradeCases)('$trade staff ownership, callback interrupts and negative callbacks preserve facts',async row=>{
  const c=context(row,channel);await c.start();await c.turn(address);
  const before={service:c.lead.serviceNeeded,address:c.lead.address};
  expect(await c.turn('Please call me')).toBeNull();
  expect(smsContactControlKind('Please call me')).toBe('callback');
  expect(classifySmsIntent({...c,customerMessage:"Don't call me; text me instead"}).intents.callback).not.toBe(true);
  c.conversation.humanTakeover=true;c.conversation.aiEnabled=false;
  expect(await c.turn('Tomorrow at 9 am')).toBeNull();
  expect({service:c.lead.serviceNeeded,address:c.lead.address}).toEqual(before);
  const receipt=contactControlReply({kind:'receipt',conversation:c.conversation});expect(receipt).not.toMatch(/will call|staff.*read/i);
 });
 test.each(multiTradeCases)('$trade unavailable request remains unconfirmed',async row=>{
  const c=context(row,channel);await c.start();await c.turn(address);getAvailability.mockResolvedValue({supportedServiceArea:true,slots:[]});
  const r=await c.turn('October 6 at 10 am');expect(c.conversation.bookingState.appointment).toBeUndefined();
  expect(r.reply).not.toMatch(/you.re booked|appointment is confirmed/i);
 });
 test('refrigerant report is handed off without water questions; failure cannot be acknowledged',async()=>{
  const row={trade:'hvac',name:'AC repair',request:'My AC is leaking refrigerant',answers:[]};const c=context(row,channel);
  if(channel==='voice') AlertService.createHumanHandoffAlert.mockRejectedValueOnce(new Error('write failed'));
  if(channel==='voice') await expect(c.turn(row.request)).rejects.toThrow('write failed');
  const r=await c.turn(row.request);expect(r.handoff.required).toBe(true);expect(r.reply).not.toMatch(/water leaking|only when you use/);
  expect(getAvailability).not.toHaveBeenCalled();
 });
 test('recurring landscape request is reviewed rather than turned into a single booking',async()=>{
  const c=context({trade:'landscaping',name:'Lawn mowing'},channel);
  const r=await c.turn('I need weekly lawn mowing');expect(r.handoff.required).toBe(true);expect(r.reply).toMatch(/recurring/i);expect(getAvailability).not.toHaveBeenCalled();
 });
});
test.each(multiTradeCases)('$trade voice handoff rejects empty persistence results',async row=>{
 const c=context(row,'voice');await c.start();await c.turn(address);AlertService.createHumanHandoffAlert.mockResolvedValue(null);
 await expect(c.turn('October 6 at 10 am')).rejects.toThrow(/not saved/);
 expect(c.conversation.conversationMemory.recoveryIntake.submitted).not.toBe(true);
});
test('scheduling tools cannot bypass missing garage door qualification',async()=>{
 const c=context(multiTradeCases.find(r=>r.trade==='garage_door'),'sms');await c.turn('My garage door spring snapped');
 await expect(assertServiceRequestEligible({businessId:'b1',leadId:'l1',conversationId:'c1',serviceOfferingId:'s1'})).rejects.toMatchObject({code:'REQUEST_QUALIFICATION_REQUIRED'});
 await c.turn('The door is closed');
 await expect(assertServiceRequestEligible({businessId:'b1',leadId:'l1',conversationId:'c1',serviceOfferingId:'s1'})).resolves.toMatchObject({decision:'supported'});
});
test.each([
 ['plumbing','My house is flooding'],['hvac','I smell gas'],['roofing','The roof is collapsing'],['electrical','The outlet is sparking'],['restoration','Smoke is filling the room'],['garage_door','A child is trapped under the garage door'],['locksmith','My baby is locked inside a hot car'],['landscaping','A tree fell on a live power line'],['appliance_repair','My dryer is on fire'],['other','Someone is unconscious']
])('%s safety preflight survives trade expansion',async(trade,customerMessage)=>{
 const r=await assessInboundSafety({customerMessage,allowAIClassifier:false});expect(r.isEmergency).toBe(true);expect(r.shouldAlertOwner).toBe(true);expect(r.reply).toMatch(/911/);
});

test.each(['sms','voice'])('%s unknown fluid is clarified; contextual gas answer preserves emergency handling',async channel=>{
 const row={trade:'hvac',name:'AC repair',request:'My AC is leaking',answers:[]};const c=context(row,channel);
 expect((await c.turn(row.request)).reply).toMatch(/substance/);
 await c.turn('Yes');expect(c.conversation.conversationMemory.recoveryIntake.triagePending).toBe(true);expect(getAvailability).not.toHaveBeenCalled();
 const r=await c.turn('gas');expect(r.messageCategory).toBe('emergency');expect(r.reply).toMatch(/911/);expect(c.lead.urgency).toBe('emergency');expect(r.riskFlags).toContain('safety_hazard');
});
