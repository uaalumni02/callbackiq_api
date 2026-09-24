import { resolveRequestAddress, extractCustomerAddress, addressFromTurn, extractCustomerPostalCode } from '../../src/services/booking/customerAddress.service.js';
import { voiceRecoveryMessage } from '../../src/voice/voiceRecoveryMessage.service.js';
const saved='970 Sidney Marcus, Atlanta GA 30324';
test('booking reuses saved customer address when the current turn is about the service',()=>{
 expect(resolveRequestAddress({customerMessage:'I need a faucet replaced',lead:{address:saved}})).toBe(saved);
});
test('legacy split street/ZIP is reconstructed without losing the unit',()=>{
 expect(resolveRequestAddress({lead:{address:'125 Main Street Apt 4B'},conversation:{bookingState:{streetAddress:'125 Main Street Apt 4B',postalCode:'30324'}}})).toBe('125 Main Street Apt 4B, 30324');
});
test('a new street never inherits the previous street’s ZIP',()=>{
 const conversation={bookingState:{status:'collecting_location',streetAddress:'125 Main Street',postalCode:'30324'}};
 expect(resolveRequestAddress({customerMessage:'Actually my address is 87 Oak Lane',lead:{address:'125 Main Street, 30324'},conversation})).toBe('87 Oak Lane');
 expect(resolveRequestAddress({lead:{address:'87 Oak Lane'},conversation})).toBe('87 Oak Lane');
});
test('ZIP-first collection is preserved when the street follows',()=>{
 expect(resolveRequestAddress({customerMessage:'125 Main Street',conversation:{bookingState:{status:'collecting_location',postalCode:'30324'}}})).toBe('125 Main Street, 30324');
});
test.each(['three zero three two four','ZIP code is three zero three two four'])('spoken ZIP answer is retained: %s',customerMessage=>{
 expect(addressFromTurn({customerMessage,knownAddress:'970 Sidney Marcus'})).toBe('970 Sidney Marcus, 30324');
 expect(extractCustomerPostalCode(customerMessage)).toBe('30324');
});
test('I already gave it reuses the current address and does not ask the customer to repeat',()=>{
 expect(resolveRequestAddress({customerMessage:'I already gave you my address',lead:{address:saved}})).toBe(saved);
});
test('address supplied with unrelated follow-up text stays bounded',()=>{
 expect(resolveRequestAddress({customerMessage:'I am at 125 Main Street Atlanta GA 30324. What about Friday?',lead:{address:saved}})).toBe('125 Main Street Atlanta GA 30324');
});
const session={business:{businessName:'Atlanta Plumbing & Drain',smsTemplate:'Hi, this is {{businessName}}. Sorry we missed your call. What service do you need?'},transcript:[{role:'customer',text:'My address is 125 Main Street, 30324'}]};
test('engaged caller receives continuation, never the missed-call introduction',()=>{
 const result=voiceRecoveryMessage(session);expect(result.kind).toBe('continuation');expect(result.body).toContain('continue your request');expect(result.body).not.toMatch(/missed your call|what service|what.*address/i);expect(result.body).toContain('Reply STOP');expect(result.body).toContain('call 911');
});
test('a failure before any caller turn retains genuine missed-call recovery',()=>{
 expect(voiceRecoveryMessage({...session,transcript:[]})).toMatchObject({kind:'introduction',body:expect.stringContaining('Sorry we missed your call')});
});
test.each(['booked','appointment_requested','callback_saved','transfer_accepted','direct_answer_resolved','caller_declined','opted_out','safety_guidance'])('completed outcome %s suppresses a new introduction',outcome=>{
 expect(voiceRecoveryMessage({...session,outcome})).toMatchObject({kind:'suppressed',body:''});
});
test.each(['booked','pending_business_confirmation'])('durable appointment %s suppresses recovery even if close outcome is not committed yet',status=>{
 expect(voiceRecoveryMessage({...session,conversation:{bookingState:{status,appointment:'a1'}}}).kind).toBe('suppressed');
});
test('only a persisted staff review suppresses continuation',()=>{
 const pending={...session,conversation:{conversationMemory:{recoveryIntake:{submitted:false,review:{status:'pending_persistence'}}}}};
 expect(voiceRecoveryMessage(pending).kind).toBe('continuation');
 pending.conversation.conversationMemory.recoveryIntake={submitted:true,review:{status:'queued'}};
 expect(voiceRecoveryMessage(pending).kind).toBe('suppressed');
});

test.each([
 ['9 70 Roswell Road, Atlanta, Georgia 3 0 3 2 4.', '970 Roswell Road, Atlanta, Georgia 30324'],
 ['I need a faucet replaced at 9 70 Roswell Road Atlanta GA 3 0 3 2 4.', '970 Roswell Road Atlanta GA 30324'],
 ['1 2 3 Oak Lane 3 0 0 6 0', '123 Oak Lane 30060'],
 ['970 Roswell Road Atlanta GA 303 24', '970 Roswell Road Atlanta GA 30324'],
])('captures ASR digit groups: %s', (input, expected) => {
 expect(extractCustomerAddress(input)).toBe(expected);
});
test('spaced phone digits do not become a service address', () => {
 expect(extractCustomerAddress('4 0 4 5 5 5 0 1 2 3')).toBe('');
 expect(extractCustomerPostalCode('4 0 4 5 5 5 0 1 2 3')).toBe('');
});
