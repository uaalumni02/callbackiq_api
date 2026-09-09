import { recoveryCompletionReply, recoveryPreferenceLabel } from '../../src/services/booking/recoveryIntakePresentation.service.js';
test.each(['available', 'unknown'])('bounded SMS preserves status and next step with long %s evidence', status => {
 const reply = recoveryCompletionReply({ lead: { serviceNeeded: 'Bathtub seal '.repeat(50), address: '123 Example Avenue '.repeat(30) }, state: { date: '2026-09-09', time: '08:00', leakPattern: 'during_use', availability: { status } } });
 expect(reply.length).toBeLessThanOrEqual(320);
 expect(reply).toContain('not confirmed');
 expect(reply).toContain('Wed, Sep 9 at 8 AM');
 expect(reply).toContain('wait for confirmation');
});
test('calendar date is unchanged by runtime timezone', () => {
 expect(recoveryPreferenceLabel({ date: '2026-09-09', time: '13:30' })).toBe('Wed, Sep 9 at 1:30 PM');
});
