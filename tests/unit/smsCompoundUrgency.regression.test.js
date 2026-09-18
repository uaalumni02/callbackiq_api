import { classifySmsIntent } from "../../src/services/messaging/smsIntentClassifier.service.js";

describe("compound SMS urgency + scheduling intent", () => {
  test("preserves loss-of-service urgency alongside a scheduling request", () => {
    const result = classifySmsIntent({
      customerMessage:
        "Loss of service. What is your availability this week?",
      business: { timezone: "America/New_York" },
      now: new Date("2026-09-04T18:00:00-04:00"),
    });

    expect(result.intents.scheduling).toBe(true);
    expect(result.intents.availabilityInquiry).toBe(true);
    expect(result.entities.urgency).toBe("high");
    expect(result.entities.range).toEqual(
      expect.objectContaining({
        startDate: "2026-09-04",
      }),
    );
  });

  test("emergency urgency remains independent from scheduling intent", () => {
    const result = classifySmsIntent({
      customerMessage:
        "I smell gas. Do you have any availability tomorrow?",
      business: { timezone: "America/New_York" },
      now: new Date("2026-09-04T18:00:00-04:00"),
    });

    expect(result.intents.scheduling).toBe(true);
    expect(result.entities.urgency).toBe("emergency");
  });
});

import { extractService } from '../../src/services/messaging/smsIntentClassifier.service.js';
import { evaluateDeterministicInboundGuardrails } from '../../src/helpers/ai/aiGuardrails.js';
test.each([
  'Tomorrow at 9pm. How much would it cost to fix something like this?',
  'How much to repair this issue?',
  'Can you fix something similar to that?',
  'How much to fix it?',
])('follow-up preserves the known service: %s', text => {
  expect(extractService(text, { lead: { serviceNeeded: 'kitchen sink clogged' } })).toBe('');
});
test.each(['How much to replace a water heater?', 'How much to repair my furnace?'])('explicit priced work remains discoverable: %s', text => {
  expect(extractService(text)).not.toBe('');
});
test.each([
  'The water is now spilling out to the floor',
  'Water is running onto the carpet',
  'My toilet is overflowing',
  'No flooding earlier, but water is now spilling onto the floor',
])('escaping water precedes eligibility: %s', text => {
  expect(evaluateDeterministicInboundGuardrails({ customerMessage: text, recentMessages: [] })).toMatchObject({ handled: true, category: 'emergency' });
});
test.each(['No water is spilling onto the floor', 'Water is not running onto the carpet'])('negated water escape is not an emergency: %s', text => {
  expect(evaluateDeterministicInboundGuardrails({ customerMessage: text, recentMessages: [] }).category).not.toBe('emergency');
});
