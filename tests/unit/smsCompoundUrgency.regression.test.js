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
