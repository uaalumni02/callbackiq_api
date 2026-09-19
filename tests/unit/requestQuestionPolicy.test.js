import { requestQuestions, updateRequestQuestions, normalizeRequestService } from '../../src/services/booking/requestQuestionPolicy.service.js';
import { sanitizeUnverifiedBookingCommitments } from '../../src/services/messaging/smsProductionInvariant.service.js';
test.each(['How much is the estimated job completion?', 'Estimated completion?', 'What is the estimated completion for the installation?'])('clarifies ambiguous completion: %s', text => {
 expect(requestQuestions(text)).toMatchObject({ambiguous:true,pricing:false});
});
test.each(['How long will it take?', 'How much time does it take?', 'How many hours for the installation?', 'How many days does the repair take?'])('separates duration from price: %s', text => {
 expect(requestQuestions(text)).toMatchObject({duration:true,pricing:false,ambiguous:false});
});
test('cost and duration are two retained questions', () => {
 const state={}; updateRequestQuestions(state,'How much will it cost and how long will it take?','m1');
 expect(state.unresolvedQuestions.map(q=>q.kind)).toEqual(['duration','price']);
});
test('clarification resolves only the ambiguity, preserves other open questions', () => {
 const state={unresolvedQuestions:[{kind:'price'}]}; updateRequestQuestions(state,'Estimated completion?','m1'); updateRequestQuestions(state,'I mean how long','m2');
 expect(state.unresolvedQuestions.map(q=>q.kind)).toEqual(['price','duration']);
});
test('pending business confirmation is not a confirmed booking', () => {
 const reply=sanitizeUnverifiedBookingCommitments("You're booked. A technician will be there.", {conversation:{bookingState:{status:'pending_business_confirmation'}}});
 expect(reply).not.toMatch(/You're booked|will be there/); expect(reply).toMatch(/not confirmed/);
});

test('normalizing greetings preserves service words beginning with an article letter', () => {
 expect(normalizeRequestService('Hi I need air conditioning repaired')).toBe('air conditioning repaired');
 expect(normalizeRequestService('I need an outlet installed')).toBe('outlet installed');
});
