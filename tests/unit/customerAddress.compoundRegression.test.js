import { extractCustomerAddress, addressFromTurn, isAddressOnlyTurn } from '../../src/services/booking/customerAddress.service.js';
const address='87 Oak Lane Marietta GA 30060';
test.each([
 `AC not cooling, ${address}, Wed Sep 9 at 8 am`,
 `My faucet needs replacement; ${address}; tomorrow at 3 pm`,
 `The furnace is noisy at ${address}, next Tuesday morning`,
 `My roof needs inspection. My address is ${address}, September 9 at 8 am`,
 `AC not cooling, 970 Sidney Marcus Atlanta GA 30324, Wed Sep 9 at 8 am`,
])('captures an embedded customer address: %s',text=>{
 const expected=text.includes('Sidney')?'970 Sidney Marcus Atlanta GA 30324':address;
 expect(extractCustomerAddress(text)).toBe(expected);
 expect(addressFromTurn({customerMessage:text})).toBe(expected);
});
test.each(['AC repair costs 200 dollars at 8 am', 'My AC needs repair, 3 bedrooms and 2 bathrooms', 'Can you come at 8 am tomorrow?'])('does not turn unrelated numbers into a location: %s',text=>expect(extractCustomerAddress(text)).toBe(''));

test.each([
 ['970 Furnace Road Atlanta GA 30324', true],
 ['nine seventy Furnace Road Atlanta GA 30324', true],
 [`AC not cooling, ${address}, Wed Sep 9 at 8 am`, false],
 [`The furnace is noisy at ${address}, next Tuesday morning`, false],
])('distinguishes a location-only turn from service plus location: %s', (text, expected) => {
 expect(isAddressOnlyTurn(text)).toBe(expected);
});
