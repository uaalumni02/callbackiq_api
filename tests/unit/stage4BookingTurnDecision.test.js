import { bookingTransitionChanges } from '../../src/services/booking/requestBookingState.js';
import {
  createBookingTurnContext, isBookingTurnBlocked, planRejectedBookingPreference,
} from '../../src/services/booking/bookingTurnDecision.policy.js';

const rejection = (overrides={}) => planRejectedBookingPreference({
  evidence:{rejectedDate:true,rejectedTime:false},
  acceptedTime:{targetMinutes:null,timeOfDay:''},
  hasReplacementDate:false, enabled:true, hasExistingAppointment:false,
  ...overrides,
});

describe('Stage4 booking decisions without persistence or provider I/O',()=>{
  test('voice retains original idempotency and event prefixes',()=>{
    expect(createBookingTurnContext({business:{features:{aiBookingEnabled:true}},channel:'voice',source:'agent',customerMessage:'  Tomorrow  '}))
      .toEqual({bookingChannel:'voice',bookingSource:'agent',bookingIdempotencyPrefix:'voice-',bookingEventPrefix:'voice:',enabled:true,text:'Tomorrow'});
  });
  test('nonvoice channels retain original SMS prefixes',()=>{
    expect(createBookingTurnContext({channel:'chat',customerMessage:null})).toEqual({bookingChannel:'sms',bookingSource:'booking_state_machine',bookingIdempotencyPrefix:'',bookingEventPrefix:'',enabled:false,text:''});
  });
  test('empty source uses original fallback',()=>{
    expect(createBookingTurnContext({source:''}).bookingSource).toBe('booking_state_machine');
  });
  test('human takeover always blocks',()=>expect(isBookingTurnBlocked({humanTakeover:true,status:'open'})).toBe(true));
  test.each(['closed','archived'])('%s remains blocked',status=>expect(isBookingTurnBlocked({status})).toBe(true));
  test('open and missing conversations remain eligible',()=>{
    expect(isBookingTurnBlocked({status:'open',humanTakeover:false})).toBe(false);
    expect(isBookingTurnBlocked(undefined)).toBe(false);
  });
  test('rejected date clears offered options without inventing confirmation',()=>{
    const plan=rejection();
    expect(bookingTransitionChanges(plan.event, plan.details)).toEqual({offeredSlots:[],selectedSlot:null,status:'collecting_preference',expiresAt:null,searchStartDate:null,searchEndDate:null,lastCustomerPreference:'',lastError:'customer_rejected_preference'});
    expect(plan.reply).toBe('What day and time would work instead? No appointment is confirmed.');
    expect(plan.updateRequestedPreference).toBe(true);
    expect(plan.category).toBe('appointment_preference');
  });
  test('existing appointment is not changed',()=>{
    const plan=rejection({hasExistingAppointment:true});
    expect(plan.updateRequestedPreference).toBe(false);
    expect(plan.reply).toContain('existing appointment has not been changed');
  });
  test('disabled booking returns not_started without adding a booking',()=>{
    expect(bookingTransitionChanges('preference_rejected', rejection({enabled:false}).details).status).toBe('not_started');
  });
  test('rejected date with a replacement date is processed by existing workflow',()=>{
    expect(rejection({hasReplacementDate:true})).toBeNull();
  });
  test('rejected time without an accepted time resets preference',()=>{
    expect(bookingTransitionChanges('preference_rejected', rejection({evidence:{rejectedTime:true,rejectedDate:false}})?.details).lastError).toBe('customer_rejected_preference');
  });
  test('rejected time with an accepted minute stays in existing workflow',()=>{
    expect(rejection({evidence:{rejectedTime:true,rejectedDate:false},acceptedTime:{targetMinutes:870,timeOfDay:''}})).toBeNull();
  });
  test('rejected time with an accepted daypart is not reset',()=>{
    expect(rejection({evidence:{rejectedTime:true,rejectedDate:false},acceptedTime:{targetMinutes:null,timeOfDay:'morning'}})).toBeNull();
  });
  test('ordinary evidence does not reset booking state',()=>{
    expect(rejection({evidence:{rejectedTime:false,rejectedDate:false}})).toBeNull();
  });
  test('input objects remain unchanged',()=>{
    const input={evidence:{rejectedDate:true},acceptedTime:{targetMinutes:null,timeOfDay:''},hasReplacementDate:false,enabled:true,hasExistingAppointment:false};
    const before=JSON.stringify(input);
    rejection(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
