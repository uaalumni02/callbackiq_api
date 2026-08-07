import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  findDateRange,
  parseTimePreference,
  filterSlotsByTimePreference,
  hasAppointmentPreferenceHint,
} from '../src/services/booking/appointmentPreferenceParser.service.js';

const TZ = 'America/New_York';
const NOW = new Date('2026-08-06T21:25:00-04:00');

const expectDate = (phrase, startDate, endDate = startDate) => {
  assert.deepEqual(findDateRange(phrase, TZ, NOW), { startDate, endDate });
};

test('relative date slang and vernacular', () => {
  expectDate('tomorrow at 2', '2026-08-07');
  expectDate('tmrw around 3ish', '2026-08-07');
  expectDate('2moro morning', '2026-08-07');
  expectDate('day after tomorrow at 10', '2026-08-08');
  expectDate('day after next around lunch', '2026-08-08');
  expectDate('overmorrow at noon', '2026-08-08');
  expectDate('in 3 days after lunch', '2026-08-09');
  expectDate('three days from now', '2026-08-09');
  expectDate('later today', '2026-08-06');
  expectDate('tonight', '2026-08-06');
});

test('weekday and week language', () => {
  expectDate('this Friday afternoon', '2026-08-07');
  expectDate('Friday at 2', '2026-08-07');
  expectDate('next Friday at 2', '2026-08-14');
  expectDate('early next week', '2026-08-10', '2026-08-12');
  expectDate('next week sometime', '2026-08-10', '2026-08-16');
  expectDate('this weekend', '2026-08-08', '2026-08-09');
  expectDate('next weekend', '2026-08-15', '2026-08-16');
});

test('calendar-date vernacular', () => {
  expectDate('August 10 at 2pm', '2026-08-10');
  expectDate('Aug 10th around 2', '2026-08-10');
  expectDate('10th of August at noon', '2026-08-10');
  expectDate('8/10 at 2', '2026-08-10');
  expectDate('08/10/2026 at 2:30pm', '2026-08-10');
  expectDate('2026-08-10 at 14:30', '2026-08-10');
  expectDate('the 10th around 4', '2026-08-10');
});

test('exact and colloquial times', () => {
  assert.equal(parseTimePreference('tomorrow at 2', TZ, NOW).exactMinutes, 14 * 60);
  assert.equal(parseTimePreference('tomorrow at 2pm', TZ, NOW).exactMinutes, 14 * 60);
  assert.equal(parseTimePreference('tomorrow 2:30 p.m.', TZ, NOW).exactMinutes, 14 * 60 + 30);
  assert.equal(parseTimePreference('tomorrow at 14:30', TZ, NOW).exactMinutes, 14 * 60 + 30);
  assert.equal(parseTimePreference('half past 10 tomorrow', TZ, NOW).exactMinutes, 10 * 60 + 30);
  assert.equal(parseTimePreference('quarter past 2 tomorrow', TZ, NOW).exactMinutes, 14 * 60 + 15);
  assert.equal(parseTimePreference('quarter to 3 tomorrow', TZ, NOW).exactMinutes, 14 * 60 + 45);
  assert.equal(parseTimePreference("2 o'clock tomorrow", TZ, NOW).exactMinutes, 14 * 60);
  assert.equal(parseTimePreference('tomorrow at noon', TZ, NOW).exactMinutes, 12 * 60);
  assert.equal(parseTimePreference('tomorrow at two', TZ, NOW).exactMinutes, 14 * 60);
  assert.equal(parseTimePreference('tomorrow at two thirty', TZ, NOW).exactMinutes, 14 * 60 + 30);
});

test('approximate and day-part slang', () => {
  let pref = parseTimePreference('day after tomorrow around 3ish', TZ, NOW);
  assert.equal(pref.targetMinutes, 15 * 60);
  assert.equal(pref.exactMinutes, null);
  assert.equal(pref.toleranceMinutes, 60);

  pref = parseTimePreference('tomorrow first thing in the morning', TZ, NOW);
  assert.equal(pref.timeOfDay, 'morning');
  assert.equal(pref.windowStartMinutes, 6 * 60);
  assert.equal(pref.windowEndMinutes, 9 * 60);

  pref = parseTimePreference('tomorrow after lunch', TZ, NOW);
  assert.equal(pref.timeOfDay, 'afternoon');
  assert.equal(pref.windowStartMinutes, 13 * 60);
  assert.equal(pref.windowEndMinutes, 18 * 60);

  pref = parseTimePreference('tomorrow after 5', TZ, NOW);
  assert.equal(pref.windowStartMinutes, 17 * 60);

  pref = parseTimePreference('tomorrow before 10', TZ, NOW);
  assert.equal(pref.windowEndMinutes, 10 * 60);

  pref = parseTimePreference('tomorrow between 2 and 4', TZ, NOW);
  assert.equal(pref.windowStartMinutes, 14 * 60);
  assert.equal(pref.windowEndMinutes, 16 * 60 + 1);

  pref = parseTimePreference('tomorrow from 8 to 10', TZ, NOW);
  assert.equal(pref.windowStartMinutes, 8 * 60);
  assert.equal(pref.windowEndMinutes, 10 * 60 + 1);

  pref = parseTimePreference('tomorrow by five', TZ, NOW);
  assert.equal(pref.windowEndMinutes, 17 * 60);
});

test('filters exact, approximate, and window preferences', () => {
  const slots = [
    { startAt: '2026-08-07T13:00:00-04:00' },
    { startAt: '2026-08-07T14:00:00-04:00' },
    { startAt: '2026-08-07T15:00:00-04:00' },
    { startAt: '2026-08-07T17:00:00-04:00' },
  ];

  let pref = parseTimePreference('tomorrow at 2', TZ, NOW);
  assert.deepEqual(filterSlotsByTimePreference(slots, pref, TZ).map((slot) => slot.startAt), [
    '2026-08-07T14:00:00-04:00',
  ]);

  pref = parseTimePreference('tomorrow around 2ish', TZ, NOW);
  assert.deepEqual(filterSlotsByTimePreference(slots, pref, TZ).map((slot) => slot.startAt), [
    '2026-08-07T13:00:00-04:00',
    '2026-08-07T14:00:00-04:00',
    '2026-08-07T15:00:00-04:00',
  ]);

  pref = parseTimePreference('tomorrow after 5', TZ, NOW);
  assert.deepEqual(filterSlotsByTimePreference(slots, pref, TZ).map((slot) => slot.startAt), [
    '2026-08-07T17:00:00-04:00',
  ]);
});

test('availability hint detects date/time slang', () => {
  for (const phrase of [
    'day after next around 3ish',
    'tmrw first thing',
    'Aug 10 at 2',
    '8/10 around lunch',
    'next Friday after work',
    'soonest you have',
  ]) {
    assert.equal(hasAppointmentPreferenceHint(phrase, TZ, NOW), true, phrase);
  }
});


test('booking state machine preserves availability-hint contract', () => {
  const source = fs.readFileSync(
    new URL('../src/services/booking/bookingStateMachine.service.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /AVAILABILITY_HINT/);
  assert.match(source, /hasBookingAvailabilityHint/);
  assert.match(source, /hasAppointmentPreferenceHint/);
});
