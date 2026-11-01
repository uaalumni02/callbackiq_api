import { fixedResult } from '../../src/services/booking/bookingFixedResult.policy.js';

test('deterministic booking response retains all existing safety metadata', () => {
  expect(fixedResult({reply:'Scheduling needs review'})).toEqual({
    decision:'send_fixed_response', actionType:'send_fixed_response', messageCategory:'appointment_preference',
    reply:'Scheduling needs review', serviceNeeded:'', urgency:'medium', address:'',
    preferredAppointmentTime:'', leadQualityScore:0, estimatedValue:0,
    summary:'The deterministic booking state machine handled this message.',
    shouldAlertOwner:false, alertPriority:'low', alertTitle:'', alertMessage:'', riskFlags:[], confidence:1,
    guardrail:{skipAI:true,reason:'booking_state_machine',usedFallback:false,violations:[]},
  });
});
test('explicit booking response type and category are preserved',()=>{
  const actual=fixedResult({reply:'No booking confirmed', category:'availability_inquiry',actionType:'human_handoff'});
  expect(actual.reply).toBe('No booking confirmed');
  expect(actual.messageCategory).toBe('availability_inquiry');
  expect(actual.actionType).toBe('human_handoff');
  expect(actual.guardrail.skipAI).toBe(true);
});
