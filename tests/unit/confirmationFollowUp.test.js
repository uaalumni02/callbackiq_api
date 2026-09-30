import { confirmationFollowUpReply } from '../../src/services/booking/confirmationFollowUp.service.js';
import { bookingQuestionReply } from '../../src/services/booking/conversationQuestions.service.js';
import { hasUnverifiedStaffCommitment } from '../../src/services/customerCommitmentSafety.service.js';

const lead = { preferredAppointmentTime: '2026-10-02 at 12:00 PM' };
const conversation = { conversationMemory: { recoveryIntake: { review: { status: 'queued', alertId: 'a1' } } } };
test.each(['sms', 'voice'])('%s gives the saved preference and an actionable callback option without inventing an SLA', channel => {
  const before = JSON.stringify({ lead, conversation });
  const reply = confirmationFollowUpReply({ lead, conversation, channel });
  expect(reply).toContain('Fri, Oct 2 at 12:00 PM');
  expect(reply).toContain('saved for team review');
  expect(reply).toContain('not a confirmed appointment');
  expect(reply).toContain(channel === 'voice' ? 'say “call me' : 'reply “call me');
  expect(reply).not.toMatch(/staff (received|read)|within \d|will (call|confirm)|reserved/i);
  expect(hasUnverifiedStaffCommitment(reply)).toBe(false);
  expect(JSON.stringify({ lead, conversation })).toBe(before);
});
test.each([undefined, { status: 'pending_persistence' }, { status: 'queued' }, { status: 'update_required', alertId: 'old' }])('missing or stale queue evidence cannot claim successful submission: %j', review => {
  const reply = confirmationFollowUpReply({ conversation: { conversationMemory: { recoveryIntake: { review } } } });
  expect(reply).toContain("can't verify that it is queued");
  expect(reply).not.toContain('saved for team review');
});
test('current lead preference wins over older intake memory', () => {
  const reply = confirmationFollowUpReply({ lead, conversation: { conversationMemory: { recoveryIntake: { preferredAppointmentTime: 'Monday at 9' } } } });
  expect(reply).toContain('Fri, Oct 2'); expect(reply).not.toContain('Monday');
});
test('callback request bypasses the read-only booking question answer', () => {
  expect(bookingQuestionReply({ customerMessage: 'Can you confirm and call me?', conversation })).toBeNull();
});

test('appointment-backed manual takeover defers to authoritative appointment lookup', () => {
 expect(bookingQuestionReply({ customerMessage: 'When will it be confirmed?', conversation: { bookingState: { status: 'human_takeover', lastError: 'selected_slot_requires_manual_confirmation', appointment: 'a1' } } })).toBeNull();
});
