import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDialogAct, evidenceSnapshot, planReadOnlyTurn, asSmsDialogResult, protectedTurnText } from '../src/services/conversationPolicy/dialogPolicy.js';
import { buildDialogState, assertNoUnauthorizedEffects, phaseFor } from '../src/services/conversationPolicy/dialogState.js';
import { repetitionRisk, preventNonProgressReply } from '../src/services/conversationPolicy/repetitionGuard.js';
import { OUTCOME, verifyOutcome } from '../src/services/conversationPolicy/outcomeContract.js';
const base = () => ({
  lead: { serviceNeeded:'leaking faucet', address:'Example Rd, Atlanta, GA 30324', preferredAppointmentTime:'2026-10-25 at evening', urgency:'low' },
  conversation: { bookingState:{status:'collecting_preference'}, humanTakeover:false, aiEnabled:true,
    conversationMemory:{ recoveryIntake:{ review:{status:'queued',alertId:'persisted_alert'} } },
    orchestration:{ recoveryJourneyKey:'j1' } },
});
function plan(text,opts={}) { const b=base(); return planReadOnlyTurn({ customerMessage:text, ...b, ...opts }); }
const progress = [
  'What is the next step?', 'What are the next steps?', 'What happens next?',
  'What comes next?', 'What should I do now?', 'What can we expect next?',
  'Where do we go from here?', 'How do we move forward from here?',
  'When will the team follow up?', 'When should I hear back?',
  'Is there an update?', 'Any update on the appointment?',
  'What is the status of my request?', 'Did you get my request?',
];
for (const message of progress) test('progress intent: '+message,()=> {
  const p=plan(message);assert.equal(p.intent,'progress_question');assert.equal(p.handled,true);
  assert.match(p.reply,/team review|business must check availability|business to review|recorded for team review/i);
  assert.match(p.reply,/no guaranteed|no visit has been confirmed|no guaranteed callback|no guaranteed callback time/i);
  assert.deepEqual(p.sideEffects,[]);assertNoUnauthorizedEffects(p);
});
const arrival=['Is the technician on the way?','Are they coming?','Has someone been dispatched?','Where is my technician?'];
for(const s of arrival)test('arrival does not invent dispatch: '+s,()=>{
  const p=plan(s);assert.equal(p.handled,true);assert.equal(p.intent,'arrival_question');
  assert.match(p.reply,/can't verify that a technician has been dispatched/);
  assert.doesNotMatch(p.reply,/technician will arrive|technician is coming/i);
});
const confirmed=['Is my appointment confirmed?','Was my visit booked?','Did they confirm it?','Have you booked my appointment?'];
for(const s of confirmed)test('booking confirmation answer never invents booking: '+s,()=>{
  const p=plan(s);assert.equal(p.handled,true);assert.equal(p.intent,'confirmation_question');
  assert.match(p.reply,/can't confirm an appointment/);
});
const unsafe=[
 'STOP','HELP','UNSUBSCRIBE','What now? My water is flooding the house!',
 'What is next? 223 Lenox Rd 30324','Can you come tonight?',
 'Is someone coming? Actually I need to cancel',
 'When do you respond? Tomorrow at 5:30pm please',
 'What happens next? Gas is leaking',
 'What happens next? I also need a roof repair',
 'What happens next? Please change my address',
 'Call me back so I can explain the issue',
 'I need to reschedule the visit',
 'I want to speak to a manager',
 'Can you book next Tuesday at 5 pm?',
 'What now? The faucet is leaking constantly',
 'What now? my ZIP is 30324',
];
for(const s of unsafe)test('compound/control bypasses read-only policy: '+s,()=>{
  assert.equal(detectDialogAct(s),null);
  assert.equal(plan(s).handled,false);
});
test('booking-backed states defer to authoritative engine',()=>{
  for(const status of ['booked','offering_slots','awaiting_confirmation','booking']){
    const b=base(); b.conversation.bookingState={status,appointment:status==='booked'?'appt-123':null};
    assert.equal(plan('What happens next?',b).handled,false);
  }
});
test('active staff ownership, inactive automation, and closure suppress automatic policy',()=>{
  const b=base();for(const alter of [{humanTakeover:true},{aiEnabled:false},{status:'closed'},{status:'archived'}]){
    assert.equal(plan('What happens next?',{...b,conversation:{...b.conversation,...alter}}).handled,false);
  }
});
test('unverified staff queue never turns into a staff notification promise',()=>{
  const b=base();b.conversation.conversationMemory.recoveryIntake.review={status:'pending_persistence'};
  const p=plan('What happens next?',b);assert.match(p.reply,/can't verify that a staff-review task is queued/);
  assert.doesNotMatch(p.reply,/staff (?:has|have) (?:received|accepted|been notified)/i);
});
test('missing details are requested only if genuinely unknown',()=>{
  const b=base();b.lead={};let p=plan('What happens next?',b);
  assert.match(p.reply,/what service/i);
  b.lead={serviceNeeded:'toilet not flushing'};p=plan('What happens next?',b);assert.match(p.reply,/service address/);
  b.lead.address='123 Example St';p=plan('What happens next?',b);assert.match(p.reply,/what day/i);
});
test('same semantic policy for voice and SMS; no fake calendar or appointment',()=>{
  const sms=plan('What happens next?',{channel:'sms'});
  const voice=plan('What happens next?',{channel:'voice'});
  assert.equal(sms.handled,voice.handled);
  assert.equal(sms.intent,voice.intent);
  assert.match(sms.reply,/business must check availability/);
  assert.match(voice.reply,/business must check availability/);
  assert.equal(sms.appointmentConfirmed,false);assert.equal(voice.appointmentConfirmed,false);
});
test('read-only result carries known facts without altering lead',()=>{
  const b=base(), prior=structuredClone(b.lead);
  const result=asSmsDialogResult(plan('What happens next?',b),b.lead);
  assert.equal(result.preferredAppointmentTime,prior.preferredAppointmentTime);
  assert.equal(result.address,prior.address);
  assert.deepEqual(b.lead,prior);
  assert.equal(result.shouldAlertOwner,false);
  assert.equal(result.guardrail.skipAI,true);
});
test('semantic interpretation understands novel wording, cannot override new facts',()=>{
  const positive={ intent:'progress_question',confidence:.98,readOnly:true,hasNewFacts:false,hasSafetyConcern:false,hasControlRequest:false };
  const p=plan('Could you explain the subsequent procedure?',{semantic:positive});assert.equal(p.handled,true);
  assert.equal(plan('Could you explain the subsequent procedure? I also need a new faucet',{semantic:positive}).handled,false);
  assert.equal(plan('Could you explain the subsequent procedure?',{semantic:{...positive,confidence:.2}}).handled,false);
  assert.equal(plan('Could you explain the subsequent procedure?',{semantic:{...positive,hasControlRequest:true}}).handled,false);
});
test('response repetition detection is semantic near-equivalence, no unsafe override',()=>{
  const messages=[{direction:'inbound',body:'What is next step?'},{direction:'outbound',body:'Your request is saved for team review. No appointment is confirmed.'}];
  assert.equal(repetitionRisk('Your request is saved for team review. No appointment is confirmed.',messages),true);
  const result={reply:messages[1].body,messageCategory:'appointment_status',decision:'send_fixed_response'};
  const ctx={result,recentMessages:messages,...base()};
  const active=preventNonProgressReply({...ctx,mode:'active'});assert.equal(active.changed,true);
  assert.notEqual(active.result.reply,result.reply);assert.match(active.result.reply,/backup day/);
  assert.equal(preventNonProgressReply({...ctx,mode:'observe'}).changed,false);
  assert.equal(preventNonProgressReply({...ctx,result:{...result,messageCategory:'emergency'},mode:'active'}).changed,false);
  assert.equal(preventNonProgressReply({...ctx,result:{...result,handoff:{required:true}},mode:'active'}).changed,false);
});
test('memory resets its repetition budget on a new missed-call journey',()=>{
  const b=base();const s=buildDialogState({previous:{version:3,journeyKey:'j1',lastIntent:'progress_question',lastAction:'answer_question',repeatedIntentCount:2},
    plan:plan('What happens next?',b),conversation:b.conversation});
  assert.equal(s.repeatedIntentCount,3);
  b.conversation.orchestration.recoveryJourneyKey='j2';
  const next=buildDialogState({previous:s,plan:plan('What happens next?',b),conversation:b.conversation});
  assert.equal(next.repeatedIntentCount,0);assert.equal(next.journeyKey,'j2');
  assert.equal(JSON.stringify(next).includes('Example Rd'),false);
});
test('state phase does not equate handoff transport acknowledgement with staff acceptance',()=>{
  const b=base();assert.equal(phaseFor({conversation:b.conversation,snapshot:{reviewQueued:true}}),'staff_review_pending');
  b.conversation.orchestration.handoffStatus='acknowledged';
  assert.equal(phaseFor({conversation:b.conversation,snapshot:{reviewQueued:false,hasService:true,hasAddress:true}}),'collecting_preference');
});
test('outcomes require authoritative proof (negative and positive)',()=>{
  for (const outcome of Object.values(OUTCOME)) assert.equal(verifyOutcome(outcome,{}).verified,false,outcome);
  assert.equal(verifyOutcome(OUTCOME.STAFF_TASK_QUEUED,{alertId:'alert',alertPersisted:true}).verified,true);
  assert.equal(verifyOutcome(OUTCOME.STAFF_ACCEPTED,{alertId:'alert',alertPersisted:true}).verified,false);
  assert.equal(verifyOutcome(OUTCOME.APPOINTMENT_CONFIRMED,{appointmentId:'appt',authoritativeStatus:'pending_business_confirmation'}).verified,false);
  assert.equal(verifyOutcome(OUTCOME.APPOINTMENT_CONFIRMED,{appointmentId:'appt',authoritativeStatus:'confirmed'}).verified,true);
  assert.equal(verifyOutcome(OUTCOME.SMS_DELIVERED,{providerMessageId:'SM123',providerAccepted:true}).verified,false);
  assert.equal(verifyOutcome(OUTCOME.SMS_DELIVERED,{deliveryReceiptId:'receipt123',providerDeliveryStatus:'delivered'}).verified,true);
});
test('read-only plans cannot grant appointment or dispatch side effects',()=>{
  assert.throws(()=>assertNoUnauthorizedEffects({handled:true,sideEffects:['dispatch']}));
  assert.throws(()=>assertNoUnauthorizedEffects({handled:true,appointmentConfirmed:true}));
  assert.throws(()=>assertNoUnauthorizedEffects({handled:true,requiresApproval:true}));
});
// Deterministic metamorphic corpus, not solely a handful of transcript strings.
test('cross-channel metamorphic variants preserve safety and question decisions',()=>{
  const questions=['What happens next?','What is the next step?','Any update on my request?'];
  const variations=q=>[q,'  '+q+'   ',q.toUpperCase(),q.replace(/\?/g,'??')];
  for(const q of questions)for(const variant of variations(q)){
    const a=plan(variant,{channel:'sms'}),b=plan(variant,{channel:'voice'});
    assert.equal(a.handled,true,variant);assert.equal(b.handled,true,variant);
    assert.equal(a.intent,b.intent,variant);assert.equal(a.snapshot.hasPreference,b.snapshot.hasPreference);
  }
  for(const q of questions)for(const suffix of [' I also have a leaking pipe',' My house is flooding',' Can you change it to tomorrow?',' 30324']){
    assert.equal(plan(q+suffix).handled,false,q+suffix);
  }
});

test('canonical turn frame retains multiple intents and observed fact kinds',async()=>{
  const {deriveTurnFrame}=await import('../src/services/conversationPolicy/turnFrame.js');
  const b=base();
  const frame=deriveTurnFrame({ ...b, customerMessage:'I need pricing and another time',
    classification:{intents:{pricing:true,reschedule:true,availabilityInquiry:true},
      entities:{range:{startDate:'2026-10-27'},serviceNeeded:'faucet'}} });
  assert.ok(frame.questions.includes('pricing_question'));
  assert.ok(frame.questions.includes('availability_question'));
  assert.ok(frame.controls.includes('reschedule_request'));
  assert.equal(frame.route,'existing_control_pipeline');
  assert.equal(frame.allowedToConfirm,false);
});
test('same canonical frame for SMS and voice understanding signals',async()=>{
  const {deriveTurnFrame}=await import('../src/services/conversationPolicy/turnFrame.js');
  const b=base();const sms=deriveTurnFrame({...b,customerMessage:'What happens next?',channel:'sms'});
  const voice=deriveTurnFrame({...b,customerMessage:'What happens next?',channel:'voice',voiceUnderstanding:{intent:'unknown'}});
  assert.deepEqual(sms.questions,voice.questions);assert.equal(sms.route,voice.route);
});

test('unresolved triage retains ownership of follow-up questions',()=>{
  const b=base();b.conversation.conversationMemory.recoveryIntake.triagePending=true;
  const p=plan('What happens next?',b);
  assert.equal(p.handled,false);assert.equal(p.reason,'qualification_engine_owns_question');
});
