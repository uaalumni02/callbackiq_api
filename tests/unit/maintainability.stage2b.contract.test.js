import { VALID_TRANSITIONS, assertTransition, getSlotClaimKeys } from '../../src/services/scheduling/appointmentStatePolicy.service.js';
import { hasBookingAvailabilityHint, isAffirmative, isNegative } from '../../src/services/booking/bookingMessagePolicy.service.js';

describe('Stage 2B stable behavioral contracts', () => {
  test('every declared appointment transition is accepted; forbidden transitions fail closed', () => {
    const states = Object.keys(VALID_TRANSITIONS);
    expect(states.sort()).toEqual(['cancel_pending','canceled','completed','confirmed','failed','held','no_show','rescheduled']);
    for (const from of states) {
      for (const to of states) {
        if (VALID_TRANSITIONS[from].has(to)) {
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          let rejected;
          try { assertTransition(from, to); } catch (error) { rejected = error; }
          expect(rejected).toMatchObject({ code: 'INVALID_APPOINTMENT_TRANSITION', statusCode:409 });
        }
      }
    }
  });
  test('availability recognition and customer decision polarity remain safe', () => {
    for (const phrase of ['tomorrow afternoon','Friday at 3pm','2026-11-05']) {
      expect(hasBookingAvailabilityHint(phrase)).toBe(true);
    }
    expect(hasBookingAvailabilityHint('please have a person call me')).toBe(false);
    expect(isAffirmative('yes, that works')).toBe(true);
    expect(isAffirmative('no, not yet')).toBe(false);
    expect(isNegative('no, not yet')).toBe(true);
  });
  test('slot claims retain tenant scheduling lane and minute boundaries', () => {
    expect(getSlotClaimKeys({startAt:'2026-11-02T15:00:40Z',endAt:'2026-11-02T15:01:10Z',capacityLane:'a'})).toEqual([
      '2026-11-02T15:00:00.000Z|lane:a',
      '2026-11-02T15:01:00.000Z|lane:a',
    ]);
  });
});
