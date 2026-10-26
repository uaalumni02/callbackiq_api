#!/usr/bin/env node
// Deterministic, isolated policy simulation. No Mongo, Twilio, OpenAI or network.
import assert from 'node:assert/strict';
import { planReadOnlyTurn, asSmsDialogResult } from '../src/services/conversationPolicy/dialogPolicy.js';
import { buildDialogState, assertNoUnauthorizedEffects } from '../src/services/conversationPolicy/dialogState.js';
import { preventNonProgressReply } from '../src/services/conversationPolicy/repetitionGuard.js';
let seed = 0xD1A109;
const next = n => { seed = (1664525 * seed + 1013904223) >>> 0; return Math.floor((seed / 4294967296) * n); };
const PROGRESS=['What happens next?','What is the next step?','When will the team follow up?',
  'Where do we go from here?','Any update on the appointment?','Is the technician on the way?',
  'Is my appointment confirmed?'];
const CONTROLS=['STOP','What happens next? I have a gas leak','What happens next? please change to tomorrow',
  'My toilet is overflowing','Cancel my appointment','My zip is 30324',
  'Actually I also need a roof repair'];
const states=['not_started','collecting_service','collecting_location','collecting_preference',
  'offering_slots','awaiting_confirmation','booking','booked'];
const count={attempts:0,handled:0,deferred:0,controlDeferred:0,failures:0,voice:0,sms:0};
const verify=(turn,channel,lead,conversation,previous)=>{
  const before=JSON.stringify({lead,bookingState:conversation.bookingState});
  const outcome=planReadOnlyTurn({customerMessage:turn,channel,lead,conversation});
  assert.equal(JSON.stringify({lead,bookingState:conversation.bookingState}),before,'policy mutated authoritative state');
  if(outcome.handled){
    assertNoUnauthorizedEffects(outcome);
    assert.equal(outcome.appointmentConfirmed,false);
    assert.doesNotMatch(outcome.reply,/your appointment (?:is|has been) confirmed|technician (?:is|will be) on the way/i);
    const response=asSmsDialogResult(outcome,lead);
    assert.equal(response.shouldAlertOwner,false);
    assert.equal(response.preferredAppointmentTime,lead.preferredAppointmentTime || '');
    const guarded=preventNonProgressReply({result:response,conversation,lead,mode:'active',recentMessages:previous});
    assert.ok(guarded.result.reply);
    count.handled++;
  } else count.deferred++;
  return buildDialogState({previous:conversation.conversationMemory.dialogPolicy,plan:outcome,conversation,channel});
};
for(let i=0;i<2400;i++){
  const lead={serviceNeeded:next(4)?'faucet repair':'',address:next(3)?'Example St, GA 30324':'',preferredAppointmentTime:next(4)?'2026-10-25 at evening':''};
  const phase=states[next(states.length)];
  const conversation={bookingState:{status:phase,...(phase==='booked'?{appointment:'confirmed-appt'}:{})},
    conversationMemory:{recoveryIntake:{review:next(2)?{status:'queued',alertId:'alert'}:{status:'not_requested'}},dialogPolicy:{}},
    orchestration:{recoveryJourneyKey:'j'+(i%15)}, aiEnabled:true, humanTakeover:next(40)===0};
  const channel=next(2)?'voice':'sms';count[channel]++;
  const turn=PROGRESS[next(PROGRESS.length)];
  const previous=next(3)?[{direction:'outbound',body:'Your requested timing is saved for team review. No appointment is confirmed.'}]:[];
  conversation.conversationMemory.dialogPolicy=verify(turn,channel,lead,conversation,previous);
  const control=CONTROLS[next(CONTROLS.length)];
  const unsafe=planReadOnlyTurn({customerMessage:control,channel,lead,conversation});
  assert.equal(unsafe.handled,false,'control or safety turn was hijacked: '+control);
  count.controlDeferred++;
  count.attempts++;
}
console.log(JSON.stringify({simulation:'conversation-policy-v3',seed:'0xD1A109',...count,pass:true},null,2));
