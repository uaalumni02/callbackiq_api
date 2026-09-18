import { handleCompoundCustomerTurn } from '../../src/services/messaging/compoundCustomerTurn.service.js';
import { planCustomerTurn, additionalServiceText } from '../../src/services/messaging/customerTurnPlan.service.js';
import { guardServiceRequest } from '../../src/services/serviceEligibility/serviceEligibility.service.js';
import { getApprovedServiceEstimate } from '../../src/services/booking/approvedServiceEstimate.service.js';
import { ensureHumanHandoffResult } from '../../src/services/messaging/smsHandoff.service.js';
jest.mock('../../src/services/serviceEligibility/serviceEligibility.service.js', () => ({ guardServiceRequest: jest.fn(), blocksServiceAutomation: () => false }));
jest.mock('../../src/services/booking/approvedServiceEstimate.service.js', () => ({ getApprovedServiceEstimate: jest.fn() }));

const business = { _id:'business', timezone:'America/New_York', features:{aiBookingEnabled:false} };
function context(count = 1) {
 const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate()+3); tomorrow.setUTCHours(16,0,0,0);
 const slots=Array.from({length:count},(_,i)=>({startAt:new Date(tomorrow.getTime()+i*3600000),endAt:new Date(tomorrow.getTime()+(i+1)*3600000)}));
 return { business, lead:{_id:'lead',serviceNeeded:'faucet replacement',address:'123 Main St',preferredAppointmentTime:'',save:jest.fn(async()=>{})},
 conversation:{_id:'conversation',status:'open',conversationMemory:{recoveryIntake:{triageAnswer:'not leaking'}},orchestration:{},
 bookingState:{status:'offering_slots',offeredSlots:slots,expiresAt:new Date(Date.now()+600000)},save:jest.fn(async()=>{})} };
}
beforeEach(()=>{jest.clearAllMocks();guardServiceRequest.mockResolvedValue(null);getApprovedServiceEstimate.mockResolvedValue('');});

test.each([
 ['That time works for me. Call me. Am I confirmed?',1,0],
 ['Call me. Option 2 works for me. Is it guaranteed?',3,1],
 ['The third option works and please call me',3,2],
 ['Yes please call me. Am I booked?',1,0],
])('captures explicit selection across clause order: %s',async(text,count,index)=>{
 const c=context(count);const original=structuredClone(c.conversation.bookingState);
 const result=await handleCompoundCustomerTurn({...c,customerMessage:text,turnId:'turn'});
 expect(c.conversation.conversationMemory.recoveryIntake.compoundTurn.selectedSlot.startAt).toEqual(original.offeredSlots[index].startAt);
 expect(result.reply).toMatch(/Requested/);expect(result.reply).toMatch(/Not a confirmed appointment/);
 expect(result.reply).toMatch(/Callback requested/);expect(c.conversation.bookingState).toEqual(original);
 expect(c.lead.preferredAppointmentTime).toBe(result.preferredAppointmentTime);
 expect(c.conversation.conversationMemory.recoveryIntake.triageAnswer).toBe('not leaking');
 expect(ensureHumanHandoffResult({...c,result,customerMessage:text}).reply).toBe(result.reply);
});
test.each([
 'That time works. Call me.',
 'Option 1. Option 2. Call me.',
 'Call me at noon. Can you guarantee an appointment?',
 'Does noon cost more? Please call me.',
 'Not that time. Call me.',
 'Option 2 does not work. Call me.',
])('does not guess an ambiguous, negated or callback time: %s',async text=>{
 const c=context(3);const result=await handleCompoundCustomerTurn({...c,customerMessage:text,turnId:'turn'});
 expect(result.reply).not.toMatch(/Requested (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/);
 expect(c.lead.preferredAppointmentTime).toBe('');
 expect(c.conversation.conversationMemory.recoveryIntake.compoundTurn.selectedSlot).toBeNull();
});
test('expired and missing-expiry offers cannot become accepted preferences',async()=>{
 for(const expiresAt of [new Date(0),null]){
  const c=context();c.conversation.bookingState.expiresAt=expiresAt;
  const result=await handleCompoundCustomerTurn({...c,customerMessage:'Option 1. Call me.',turnId:'turn'});
  expect(result.reply).toMatch(/expired/);expect(c.lead.preferredAppointmentTime).toBe('');
 }
});
test('a failed lead projection is repaired from the durable decision without reinterpreting an expired offer',async()=>{
 const c=context();c.lead.save.mockRejectedValueOnce(new Error('db unavailable'));
 const input={...c,customerMessage:'Option 1. Call me. Is it confirmed?',turnId:'one'};
 await expect(handleCompoundCustomerTurn(input)).rejects.toThrow('db unavailable');
 const stored=structuredClone(c.conversation.conversationMemory.recoveryIntake.compoundTurn.result);
 c.lead.preferredAppointmentTime='';c.conversation.bookingState.expiresAt=new Date(0);
 const result=await handleCompoundCustomerTurn(input);
 expect(result).toEqual(stored);expect(c.lead.preferredAppointmentTime).toBe(stored.preferredAppointmentTime);
 expect(guardServiceRequest).toHaveBeenCalledTimes(1);
});
test.each(['STOP','Please stop texting me','Cancel my appointment. Call me.','I smell gas. Option 1. Call me.'])('consent, withdrawal and safety retain precedence: %s',async text=>{
 const c=context();expect(await handleCompoundCustomerTurn({...c,customerMessage:text})).toBeNull();
 expect(c.conversation.save).not.toHaveBeenCalled();
});
test.each([{humanTakeover:true},{aiEnabled:false},{status:'closed'},{status:'archived'}])('does not resume paused automation: %j',async overrides=>{
 const c=context();Object.assign(c.conversation,overrides);
 expect(await handleCompoundCustomerTurn({...c,customerMessage:'Option 1. Call me.'})).toBeNull();
});
test('price plus callback answers both without asserting appointment confirmation',async()=>{
 const c=context();c.conversation.bookingState={status:'not_started'};
 getApprovedServiceEstimate.mockResolvedValue('Rough estimate: $100–$200. Final pricing depends on evaluation.');
 const result=await handleCompoundCustomerTurn({...c,customerMessage:'How much? Please call me.'});
 expect(result.reply).toContain('$100');expect(result.reply).toContain('Callback requested');
 expect(result.reply.length).toBeLessThanOrEqual(320);
});
test('a confirmation question cannot downgrade a real appointment to an unconfirmed request',async()=>{
 const c=context();c.conversation.bookingState={status:'booked',appointment:'existing'};
 const result=await handleCompoundCustomerTurn({...c,customerMessage:'Is my appointment guaranteed? Call me.'});
 expect(result.reply).toMatch(/verify your appointment status/);
 expect(c.conversation.bookingState).toEqual({status:'booked',appointment:'existing'});
});
test('availability plus callback acknowledges the unanswered availability question',async()=>{
 const c=context();c.conversation.bookingState={status:'not_started'};
 const result=await handleCompoundCustomerTurn({...c,customerMessage:'Do you have anything available tomorrow afternoon? Please call me.'});
 expect(result.reply).toMatch(/availability question needs staff review/);
 expect(result.reply).toMatch(/Callback requested/);
 expect(result.reply).toMatch(/no opening is verified/);
});
test('rescheduling plus callback leaves the existing appointment unchanged',async()=>{
 const c=context();c.conversation.bookingState={status:'booked',appointment:'existing'};
 const result=await handleCompoundCustomerTurn({...c,customerMessage:'Reschedule my appointment to Friday afternoon. Call me at noon.'});
 expect(result.reply).toMatch(/rescheduling request needs staff review/);
 expect(result.reply).toMatch(/Callback requested/);
 expect(c.lead.preferredAppointmentTime).toMatch(/friday afternoon/i);
 expect(c.lead.preferredAppointmentTime).not.toMatch(/\bnoon\b|12:00/);
 expect(c.conversation.bookingState).toEqual({status:'booked',appointment:'existing'});
});
test.each(['Also call me','Can you also tell me how much?','Also tomorrow afternoon'])('an extra conversational intent is not a second service: %s',text=>{
 expect(additionalServiceText(text,{serviceNeeded:'faucet replacement'})).toBe('');
});
test('replacement and additional work have different plans',()=>{
 const c=context();
 expect(planCustomerTurn({...c,customerMessage:'Actually roof repair instead'}).additionalRequest).toBe('');
 expect(planCustomerTurn({...c,customerMessage:'Can you also repair my roof? I still need the faucet.'}).additionalRequest).toMatch(/roof/);
});
