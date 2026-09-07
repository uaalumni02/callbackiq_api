import { bookingQuestionReply, isConfirmationQuestion, isAmbiguousServiceLoss, serviceLossQuestion } from '../../src/services/booking/conversationQuestions.service.js';
import { hasUnverifiedStaffCommitment } from '../../src/services/customerCommitmentSafety.service.js';
test.each([undefined, null, '', 0, 'hello', 'my drain is blocked'])('non-questions do not trigger booking answers: %s', value => {
  expect(isConfirmationQuestion(value)).toBe(false);
  expect(bookingQuestionReply({ customerMessage: value })).toBeNull();
});
test.each(['Will someone confirm?', 'Can you confirm the appointment?', 'is it booked?', 'was my appointment booked?'])('recognizes confirmation questions: %s', value => expect(isConfirmationQuestion(value)).toBe(true));
test.each([undefined, null, '', 'loss of service', 'a loss of service.', "it's a loss of service!", 'there is a loss of service', 'it is a loss of service', 'loss of service to my sink'])('distinguishes vague service loss from specific descriptions: %s', value => {
  const expected = typeof value === 'string' && value.includes('loss of service') && !value.includes('sink');
  expect(isAmbiguousServiceLoss(value)).toBe(expected);
});
test('service-loss clarification asks about scope without promising staff action', () => {
  expect(serviceLossQuestion).toMatch(/whole property/);
  expect(serviceLossQuestion).toMatch(/leaking or overflowing/);
  expect(hasUnverifiedStaffCommitment(serviceLossQuestion)).toBe(false);
});
test.each(['call me', 'speak to someone', 'talk to someone', 'human', 'representative', 'cancel', 'reschedule'])('does not consume an explicit %s request with generic confirmation copy', request => {
  expect(bookingQuestionReply({ customerMessage: `Can you confirm and ${request}?`, conversation: { bookingState: { status: 'offering_slots' } } })).toBeNull();
});
test.each([undefined, null, {}, { bookingState: null }, { bookingState: {} }, { bookingState: { status: 'confirmed' } }, { bookingState: { status: 'human_takeover', lastError: 'other' } }])('missing or appointment-backed state requires authoritative lookup: %j', conversation => {
  expect(bookingQuestionReply({ customerMessage: 'Is it booked?', conversation })).toBeNull();
});
test.each([
  [{ status: 'human_takeover', lastError: 'selected_slot_requires_manual_confirmation' }, /not a confirmed appointment/],
  [{ status: 'offering_slots' }, /no appointment has been submitted or reserved/],
  [{ status: 'awaiting_confirmation' }, /has not been submitted yet/],
])('read-only booking answers accurately describe pending state: %j', (bookingState, expected) => {
  const before = { ...bookingState };
  const reply = bookingQuestionReply({ customerMessage: 'Who will confirm?', conversation: { bookingState } });
  expect(reply).toMatch(expected);
  expect(hasUnverifiedStaffCommitment(reply)).toBe(false);
  expect(bookingState).toEqual(before);
});
