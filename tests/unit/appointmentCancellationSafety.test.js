import { isRequestWithdrawal } from '../../src/services/conversationControlPolicy.js';
const keep = [
 "Don't cancel my appointment",
 'Do not cancel my appointment',
 'What happens if I cancel my appointment?',
 'Can I cancel my appointment?',
 'If I cancel my appointment, is there a fee?',
 "I didn't ask you to cancel my appointment",
 "I didn't say cancel my appointment",
 'I do not want you to cancel my appointment',
 'Please keep my appointment; do not cancel it',
 'My wife said cancel my appointment, but I want to keep it',
 'Cancel my appointment? No, keep it please',
 'I was going to cancel my appointment, but I changed my mind',
 'My wife said cancel my appointment',
 'Yesterday I wanted to cancel my appointment',
 'Cancel my appointment if there is no fee',
 'I didn’t ask you to cancel my appointment',
 'I did not say cancel my appointment',
];
const cancel = ['Cancel my appointment', 'Please cancel my appointment.', 'Cancel the booking', 'I no longer need the appointment', 'Never mind', 'Please cancel that request', 'I would like to cancel my appointment', 'Cancel my appointment. Call me.', 'Actually, cancel my appointment', 'Please withdraw my request'];
for (const [label, transform] of [['original',x=>x],['uppercase',x=>x.toUpperCase()],['extra whitespace',x=>'  '+x.replaceAll(' ','   ')+'  ']]) {
 describe(`destructive cancellation language / ${label}`,()=>{
  test.each(keep)('must preserve appointment: %s',phrase=>expect(isRequestWithdrawal(transform(phrase))).toBe(false));
  test.each(cancel)('recognizes explicit withdrawal: %s',phrase=>expect(isRequestWithdrawal(transform(phrase))).toBe(true));
 });
}
