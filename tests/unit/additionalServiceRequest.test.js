import { preserveAdditionalServiceRequest } from '../../src/services/serviceEligibility/additionalServiceRequest.service.js';
import { additionalServiceText } from '../../src/services/messaging/customerTurnPlan.service.js';
import AlertService from '../../src/services/alert.service.js';
jest.mock('../../src/services/alert.service.js',()=>({__esModule:true,default:{create:jest.fn()}}));
const fixture=()=>({business:{_id:'b'},lead:{_id:'l',serviceNeeded:'AC repair',address:'123 Main St',preferredAppointmentTime:'Friday'},
 conversation:{_id:'c',orchestration:{recoveryJourneyKey:'journey'},serviceEligibility:{decision:'supported',serviceId:'ac'},
  bookingState:{status:'booked',appointment:'appointment'},conversationMemory:{recoveryIntake:{triageAnswer:'no cooling'}},save:jest.fn(async()=>{})},
 request:'roof repair',customerMessage:'Can you also repair my roof?'});
beforeEach(()=>{jest.clearAllMocks();AlertService.create.mockResolvedValue({alert:{_id:'a'}});});
test.each(['supported','unsupported','needs_staff_review','needs_clarification'])('%s additional work never replaces the primary service or appointment',async decision=>{
 const c=fixture(),primary=structuredClone(c.lead),booking=structuredClone(c.conversation.bookingState);
 const result=await preserveAdditionalServiceRequest({...c,evaluate:async()=>({decision,reason:'test'})});
 expect(c.lead).toEqual(primary);expect(c.conversation.bookingState).toEqual(booking);
 expect(c.conversation.serviceEligibility).toEqual({decision:'supported',serviceId:'ac'});
 expect(result.additionalRequest.accepted).toBe(false);expect(result.reply).toMatch(/request stays active/);
 expect(result.reply).toMatch(/not been added/);
 expect(c.conversation.conversationMemory.recoveryIntake.triageAnswer).toBe('no cooling');
});
test('failed task persistence cannot produce a saved-request acknowledgment',async()=>{
 const c=fixture();AlertService.create.mockResolvedValue(null);
 await expect(preserveAdditionalServiceRequest({...c,evaluate:async()=>({decision:'needs_staff_review'})})).rejects.toThrow('not saved');
 expect(c.conversation.save).not.toHaveBeenCalled();
 expect(c.conversation.conversationMemory.recoveryIntake.additionalRequests).toBeUndefined();
});
test('catalog outage safely asks for separate review without blocking the known primary service',async()=>{
 const c=fixture();const result=await preserveAdditionalServiceRequest({...c,evaluate:async()=>{throw new Error('offline');}});
 expect(result.additionalRequest.decision).toBe('needs_staff_review');
 expect(c.conversation.serviceEligibility.decision).toBe('supported');
});
test('retries use one task identity and bounded request memory without discarding primary details',async()=>{
 const c=fixture(),evaluate=async()=>({decision:'supported'});
 await preserveAdditionalServiceRequest({...c,evaluate});await preserveAdditionalServiceRequest({...c,evaluate});
 expect(AlertService.create.mock.calls[0][0].dedupeKey).toBe(AlertService.create.mock.calls[1][0].dedupeKey);
 expect(c.conversation.conversationMemory.recoveryIntake.additionalRequests).toHaveLength(1);
 for(let i=0;i<12;i++)await preserveAdditionalServiceRequest({...c,evaluate,request:`additional work ${i}`});
 expect(c.conversation.conversationMemory.recoveryIntake.additionalRequests).toHaveLength(10);
 expect(c.lead.serviceNeeded).toBe('AC repair');
});
test.each(['The faucet also leaks','It also makes noise','My AC also rattles'])('new symptoms stay with the original request: %s',text=>{
 expect(additionalServiceText(text,{serviceNeeded:'AC repair'})).toBe('');
});
test.each(['Can you repair my roof too?','Can you do roof repair as well?','I also need roof repair'])('additional wording preserves request identity: %s',text=>{
 expect(additionalServiceText(text,{serviceNeeded:'AC repair'})).toMatch(/roof/);
});
test('follow-up pricing about additional work does not replace the primary request',()=>{
 const c=fixture();c.conversation.conversationMemory.recoveryIntake.additionalRequests=[{request:'roof repair'}];
 expect(additionalServiceText('How much would roof repair cost?',c.lead,c.conversation)).toBe('roof repair');
 expect(additionalServiceText('Actually I need roof repair instead',c.lead,c.conversation)).toBe('');
});
