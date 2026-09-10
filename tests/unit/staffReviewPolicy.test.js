import { staffReviewDueAt } from '../../src/services/staffReviewPolicy.service.js';
const now = new Date('2026-09-10T12:00:00Z');
afterEach(() => { delete process.env.STAFF_EMERGENCY_REVIEW_SLA_MINUTES; delete process.env.SMS_EMERGENCY_CALLBACK_SLA_MINUTES; });
test.each([['critical',5],['high',10],['medium',15]])('%s review deadline is shared across SMS and voice', (priority, minutes) => {
 expect(+staffReviewDueAt(priority, now) - +now).toBe(minutes * 60000);
});
test('preserves legacy configuration and bounds invalid settings', () => {
 process.env.SMS_EMERGENCY_CALLBACK_SLA_MINUTES = '7';
 expect(+staffReviewDueAt('critical',now)-+now).toBe(7*60000);
 process.env.STAFF_EMERGENCY_REVIEW_SLA_MINUTES = 'invalid';
 expect(+staffReviewDueAt('critical',now)-+now).toBe(5*60000);
 process.env.STAFF_EMERGENCY_REVIEW_SLA_MINUTES = '999';
 expect(+staffReviewDueAt('critical',now)-+now).toBe(240*60000);
});
