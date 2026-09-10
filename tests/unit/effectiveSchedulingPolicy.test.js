import { effectiveSchedulingPolicy } from '../../src/services/scheduling/effectiveSchedulingPolicy.service.js';
import { validateBookingWindow } from '../../src/services/scheduling/appointmentPolicy.service.js';
import { filterAutomatedSlots } from '../../src/services/scheduling/automatedSchedulingPolicy.service.js';
const now = new Date('2026-09-10T14:00:00Z');
const check = (policy, service, minutes) => validateBookingWindow({ policy: effectiveSchedulingPolicy(policy,service), now, timeZone:'America/New_York', startAt:new Date(+now+minutes*60000) });
test('default policy still requires 24 hours and disables same-day bookings',()=>{
 expect(effectiveSchedulingPolicy()).toMatchObject({minimumNoticeMinutes:1440,allowSameDayBooking:false});
 expect(()=>check({}, {}, 60)).toThrow(/Same-day/);
 expect(()=>check({}, {}, 1440)).not.toThrow();
});
test('explicit service overrides can permit same-day without bypassing notice',()=>{
 const policy={minimumNoticeMinutes:1440,allowSameDayBooking:false};
 const service={minimumNoticeMinutesOverride:60,allowSameDayBookingOverride:true};
 expect(()=>check(policy,service,59)).toThrow(/minimum notice/);
 expect(()=>check(policy,service,60)).not.toThrow();
 const slot={startAt:new Date(+now+60*60000),endAt:new Date(+now+120*60000)};
 expect(filterAutomatedSlots([slot],now)).toEqual([slot]);
});
test('zero is an explicit override; malformed values retain policy defaults',()=>{
 expect(effectiveSchedulingPolicy({minimumNoticeMinutes:120},{minimumNoticeMinutesOverride:0}).minimumNoticeMinutes).toBe(0);
 for(const value of [-1,'',null,'invalid',Infinity]) expect(effectiveSchedulingPolicy({minimumNoticeMinutes:120},{minimumNoticeMinutesOverride:value}).minimumNoticeMinutes).toBe(120);
});
