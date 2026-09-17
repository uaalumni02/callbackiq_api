import { extractCustomerAddress, addressFromTurn } from '../../src/services/booking/customerAddress.service.js';
test.each([
 ['970 Sidney Marcus Atlanta, Ga 30324','970 Sidney Marcus Atlanta, Ga 30324'],
 ['My address is 970 Sidney Marcus Atlanta GA 30324','970 Sidney Marcus Atlanta GA 30324'],
 ['970 Sidney Marcus Blvd NE, Apt 4, Atlanta GA 30324','970 Sidney Marcus Blvd NE, Apt 4, Atlanta GA 30324'],
 ['nine seventy Sidney Marcus Atlanta GA zip three zero three two four','970 Sidney Marcus Atlanta GA 30324'],
 ['nine seven zero Sidney Marcus Atlanta GA 30324','970 Sidney Marcus Atlanta GA 30324'],
 ['nine hundred seventy Sidney Marcus Atlanta GA 30324','970 Sidney Marcus Atlanta GA 30324'],
 ['970 Sidney Marcus Atlanta GA 30324 tomorrow at 3 pm','970 Sidney Marcus Atlanta GA 30324'],
])('captures customer address %s', (input, expected) => expect(extractCustomerAddress(input)).toBe(expected));
test.each(['30324', '200 dollars for repair 30324', '3 bedrooms Atlanta 30324', '3 pm tomorrow', '125 please send someone to 30324', '970', 'I need a roof'])('does not mistake unrelated input for an address: %s', input => expect(extractCustomerAddress(input,{expected:true})).toBe(''));
test('captures partial street only when asked, without declaring validation',()=> {
 expect(extractCustomerAddress('970 Sidney Marcus',{expected:true})).toBe('970 Sidney Marcus');
 expect(extractCustomerAddress('970 Sidney Marcus')).toBe('');
});
test('recovers repeat correction only from inbound current journey',()=> {
 const messages=[{direction:'inbound',body:'970 Sidney Marcus Atlanta GA 30324',createdAt:'2026-09-16T21:00:00Z'}, {direction:'outbound',body:'100 Wrong Road 99999',createdAt:'2026-09-16T21:01:00Z'}];
 expect(addressFromTurn({customerMessage:'I just told you the address',recentMessages:messages})).toContain('970 Sidney');
 expect(addressFromTurn({customerMessage:'I already sent it',recentMessages:messages,conversation:{orchestration:{recoveryJourneyStartedAt:'2026-09-16T22:00:00Z'}}})).toBe('');
});
