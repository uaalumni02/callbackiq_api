import { findDateRange, parseTimePreference, filterSlotsByTimePreference } from '../../src/services/booking/appointmentPreferenceParser.service.js';
import { captureTurnFacts } from '../../src/services/booking/turnFactCapture.service.js';
const now = new Date('2026-09-23T14:00:00Z');
const zone = 'America/New_York';

test.each([
 ["I can't do Monday. Friday at 10 am works", '2026-09-25', 600],
 ['Monday at 9 am, actually Friday at 10 am', '2026-09-25', 600],
 ['No leaking and Friday at 10 am works', '2026-09-25', 600],
 ['Not tomorrow, Friday at 10 am', '2026-09-25', 600],
 ['Tuesday at 10 am instead of Monday at 9 am', '2026-09-29', 600],
 ['Friday at 10 am rather than Monday at 9 am', '2026-09-25', 600],
 ['Friday at 10 am, not Monday at 9 am', '2026-09-25', 600],
 ['Monday does not work; Friday at 10 a.m. works', '2026-09-25', 600],
 ['Monday is not good, Friday at 10 am works', '2026-09-25', 600],
 ["I can’t make Monday or Tuesday, but Friday at 10 am works", '2026-09-25', 600],
 ['Not September 24 at 9 am; September 25 at 10 am', '2026-09-25', 600],
 ['Not 2026-09-24 at 9 am; 2026-09-25 at 10 am', '2026-09-25', 600],
 ['Friday at 10 am instead of 9 am', '2026-09-25', 600],
 ['No leaking or flooding. Friday at 10 am works', '2026-09-25', 600],
])('uses accepted date/time together: %s', (text, date, minutes) => {
 expect(findDateRange(text,zone,now)).toEqual({startDate:date,endDate:date});
 expect(parseTimePreference(text,zone,now).exactMinutes).toBe(minutes);
 expect(captureTurnFacts({customerMessage:text,now,business:{timezone:zone}}).preferredAppointmentTime).toBe(`${date} at ${Math.floor(minutes/60)}:00`);
});
test.each(['Not tomorrow', "Monday doesn't work", 'Monday is not good', "I can't do Monday or Tuesday", 'Not Monday at 9 am'])('a rejected date is not an accepted preference: %s',text=>{
 expect(findDateRange(text,zone,now)).toBeNull();
 expect(parseTimePreference(text,zone,now).targetMinutes).toBeNull();
});
test.each(['Friday not before 3 pm', 'Friday no earlier than 3 pm'])('preserves positive lower bounds: %s',text=>{
 const pref=parseTimePreference(text,zone,now);
 expect(pref.windowStartMinutes).toBe(900);
 expect(findDateRange(text,zone,now).startDate).toBe('2026-09-25');
 expect(filterSlotsByTimePreference([{startAt:'2026-09-25T14:00:00-04:00'},{startAt:'2026-09-25T16:00:00-04:00'}],pref,zone)).toEqual([{startAt:'2026-09-25T16:00:00-04:00'}]);
});
test('retains ISO ranges and ordinary day/time windows',()=>{
 expect(findDateRange('2026-09-25 through 2026-09-28',zone,now)).toEqual({startDate:'2026-09-25',endDate:'2026-09-28'});
 expect(parseTimePreference('Friday between 2 pm and 4 pm',zone,now)).toMatchObject({windowStartMinutes:840,windowEndMinutes:961});
});
