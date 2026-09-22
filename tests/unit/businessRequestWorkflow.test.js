import { ordinaryReview, reviewJourney, combinedReview, validateFacts, validateOutcome, workflowVersion } from '../../src/services/businessRequestWorkflow.service.js';
const started=new Date('2026-09-21T20:00:00Z');
const conversation={_id:'c',orchestration:{recoveryJourneyKey:'journey-1',recoveryJourneyStartedAt:started}};
const row=(n,extra={})=>({_id:`a${n}`,type:'human_requested',dedupeKey:`ai_review:SM${n}`,conversation:'c',lead:'l',priority:'high',createdAt:new Date(+started+n*1000),metadata:{},...extra});
test('four intake alerts become one current request with four distinct historical events',()=>{
 const rows=[row(1),row(2),row(3),row(4,{title:'Ready for review',metadata:{intakeReview:{address:'907 Run Rd'}}})];
 expect(rows.map(r=>reviewJourney(r,conversation))).toEqual(Array(4).fill('journey-1'));
 const result=combinedReview(rows);expect(result.title).toBe('Ready for review');expect(result.reviewEvents).toHaveLength(4);expect(result.memberIds).toHaveLength(4);
});
test('safety, delivery, older journeys and unknown legacy boundaries never silently combine',()=>{
 expect(ordinaryReview(row(1,{type:'safety_emergency'}))).toBe(false);
 expect(ordinaryReview(row(1,{metadata:{riskFlags:['safety_hazard']}}))).toBe(false);
 expect(reviewJourney(row(1,{type:'message_delivery_failure'}),conversation)).toBeNull();
 expect(reviewJourney(row(-1),conversation)).toBeNull();
 expect(reviewJourney(row(1),{orchestration:{}})).toBeNull();
 expect(reviewJourney(row(1,{metadata:{reviewJourneyKey:'older'}}),conversation)).toBe('older');
});
test('canonical history preserves acknowledgment and assignment from legacy records',()=>{
 const ack=new Date();const result=combinedReview([row(1,{assignedTo:'owner',acknowledgedAt:ack}),row(2,{metadata:{requestReview:true}})]);
 expect(result).toMatchObject({_id:'a2',assignedTo:'owner',acknowledgedAt:ack});
});
test.each(['customer_declined','unable_to_service','follow_up','booked'])('outcome %s requires a meaningful reason',outcome=>{
 expect(()=>validateOutcome({outcome,reason:''},{review:row(1)})).toThrow('reason');
});
test('booked requires persisted confirmation, not a requested slot',()=>{
 expect(()=>validateOutcome({outcome:'booked',reason:'Customer accepted'},{review:row(1),appointment:{status:'pending_business_confirmation'}})).toThrow('confirm');
 expect(()=>validateOutcome({outcome:'booked',reason:'Customer accepted'},{review:row(1),appointment:{status:'confirmed'}})).not.toThrow();
});
test('decline does not implicitly cancel a confirmed appointment',()=>{
 expect(()=>validateOutcome({outcome:'customer_declined',reason:'Customer declined'},{review:row(1),appointment:{status:'confirmed'}})).toThrow('existing appointment');
});
test('follow-up requires a future reminder and permits no implicit closure',()=>{
 const now=new Date('2026-09-22T12:00:00Z');const snapshot={review:row(1)};
 expect(()=>validateOutcome({outcome:'follow_up',reason:'Call customer',followUpAt:'2026-09-22T11:00:00Z'},snapshot,now)).toThrow('future');
 expect(()=>validateOutcome({outcome:'follow_up',reason:'Call customer',followUpAt:'2026-09-23T11:00:00Z'},snapshot,now)).not.toThrow();
});
test('separate exceptions have issue-addressed or follow-up outcomes',()=>{
 expect(()=>validateOutcome({outcome:'booked',reason:'Appointment booked'},{review:row(1,{type:'safety_emergency'}),appointment:{status:'confirmed'}})).toThrow('type');
 expect(()=>validateOutcome({outcome:'issue_resolved',reason:'Spoke to customer'},{review:row(1,{type:'safety_emergency'})})).not.toThrow();
});
test('fact corrections permit only the four reviewed customer fields',()=>{
 expect(validateFacts({address:' 907 Run Rd ',preferredAppointmentTime:'Friday noon'})).toEqual({address:'907 Run Rd',preferredAppointmentTime:'Friday noon'});
 for(const changes of [{status:'booked'},{urgency:'low'},{customerName:'Missed Call Lead'},{address:{$set:'bad'}}])expect(()=>validateFacts(changes)).toThrow();
});
test('version changes when customer facts, staff ownership, or appointment evidence changes',()=>{
 const snapshot={conversation,lead:{customerName:'Sam'},members:[row(1)]};const version=workflowVersion(snapshot);
 expect(workflowVersion({...snapshot,lead:{customerName:'Jo'}})).not.toBe(version);
 expect(workflowVersion({...snapshot,members:[row(1,{assignedTo:'owner'})]})).not.toBe(version);
 expect(workflowVersion({...snapshot,appointment:{status:'confirmed'}})).not.toBe(version);
});
