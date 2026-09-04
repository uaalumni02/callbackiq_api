import {
  applySmsTurnPolicy,
  evaluateSmsTurnPolicy,
  extractServiceNeed,
} from "../../src/services/messaging/smsTurnPolicy.service.js";

// CALLBACKIQ_RESTORE_SMS_TEST_TIME
afterEach(() => {
  jest.useRealTimers();
});


const business = (overrides = {}) => ({
  businessName: "Birmingham Plumbing",
  timezone: "America/Chicago",
  features: { aiBookingEnabled: false },
  ...overrides,
});

describe("SMS market-readiness turn policy", () => {
  test.each([
    ["I have a clogged toilet", "a clogged toilet"],
    ["Need help with a broken water heater", "a broken water heater"],
    ["We have a leaking faucet", "a leaking faucet"],
    ["My toilet is completely blocked.", "toilet is completely blocked"],
  ])("extracts service context: %s", (message, expected) => {
    expect(extractServiceNeed(message)).toBe(expected);
  });

  test.each([
    "Tomorrow at 9am are you available for the service?",
    "Friday morning works",
    "Monday after 3",
    "day after tomorrow around 3ish",
    "Aug 20 at 2:30",
    "after work tomorrow",
  ])(
    "captures appointment preferences when auto-booking is unavailable: %s",
    (message) => {
      const policy = evaluateSmsTurnPolicy({
        customerMessage: message,
        business: business(),
        lead: { serviceNeeded: "clogged toilet" },
        now: new Date("2026-08-17T20:00:00-05:00"),
      });

      expect(policy.intent.scheduling).toBe(true);
      expect(policy.directResult).toBeTruthy();
      expect(policy.directResult.preferredAppointmentTime).toBe(message);
      expect(policy.directResult.reply).toContain("I've noted");
      expect(policy.directResult.reply).not.toMatch(
        /reply with the days and times/i,
      );
      expect(policy.directResult.reply).not.toMatch(
        /are you available for the service\?/i,
      );
    },
  );

  it("routes an availability question to live availability without persisting the question as a preference", () => {
    const message = "What is you availability this week?";
    const testBusiness = business();
    const lead = {
      serviceNeeded: "sink is clogged",
      preferredAppointmentTime: "",
    };
    const policy = evaluateSmsTurnPolicy({
      customerMessage: message,
      business: testBusiness,
      lead,
      now: new Date("2026-09-03T22:00:00-04:00"),
    });

    expect(policy.intent.availabilityInquiry).toBe(true);
    expect(policy.intent.scheduling).toBe(true);
    expect(policy.appointmentHint).toBe(true);
    expect(policy.directResult).toBeNull();

    const result = applySmsTurnPolicy({
      business: testBusiness,
      lead,
      policy,
      result: {
        reply: "The business will confirm availability.",
        preferredAppointmentTime: message,
      },
    });

    expect(result.preferredAppointmentTime).toBe("");
    expect(result.reply).not.toContain("I've noted");
  });

  it("does not convert a generic booking request into a fake time preference", () => {
    const policy = evaluateSmsTurnPolicy({
      customerMessage: "book",
      business: business(),
      lead: {},
    });

    expect(policy.intent.scheduling).toBe(true);
    expect(policy.appointmentHint).toBe(false);
    expect(policy.directResult).toBeNull();
  });

  it("does not steal scheduling from the real booking state machine when enabled", () => {
    const policy = evaluateSmsTurnPolicy({
      customerMessage: "Tomorrow at 9am",
      business: business({ features: { aiBookingEnabled: true } }),
      lead: { serviceNeeded: "clogged toilet" },
      now: new Date("2026-08-17T20:00:00-05:00"),
    });

    expect(policy.intent.scheduling).toBe(true);
    expect(policy.directResult).toBeNull();
  });

  it("replaces the exact broken re-ask regression", () => {
    // CALLBACKIQ_FIXED_SMS_REGRESSION_TIME
    // Keep "tomorrow at 9am" deterministic instead of depending on CI date.
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-18T16:00:00.000Z"));

    const message = "Tomorrow at 9am are you available for the service?";
    const testBusiness = business();
    const policy = evaluateSmsTurnPolicy({
      customerMessage: message,
      business: testBusiness,
      lead: { serviceNeeded: "clogged toilet" },
    });

    const result = applySmsTurnPolicy({
      business: testBusiness,
      lead: { serviceNeeded: "clogged toilet" },
      policy,
      result: {
        decision: "send",
        actionType: "collect_appointment_preference",
        messageCategory: "appointment_preference",
        reply:
          "You can reply with the days and times that work best for you. The business will respond as soon as possible to confirm availability.",
      },
    });

    expect(result.reply).toContain("I've noted");
    expect(result.reply).toMatch(/Wednesday, Aug 19 at 9:00 AM/i);
    expect(result.reply).not.toContain(message);
    expect(result.reply).not.toMatch(/reply with the days and times/i);
    expect(result.preferredAppointmentTime).toBe(message);
  });

  it("prevents service statements from jumping directly to scheduling", () => {
    const testBusiness = business();
    const policy = evaluateSmsTurnPolicy({
      customerMessage: "I have a clogged toilet",
      business: testBusiness,
      lead: {},
    });

    const result = applySmsTurnPolicy({
      policy,
      business: testBusiness,
      lead: {},
      result: {
        reply: "You can reply with the days and times that work best for you.",
        decision: "send",
        actionType: "collect_appointment_preference",
        messageCategory: "appointment_preference",
      },
    });

    expect(result.serviceNeeded).toBe("a clogged toilet");
    expect(result.reply).toMatch(
      /active leak|overflow|loss of service/i,
    );
    expect(result.reply).not.toMatch(/days and times/i);
  });

  it("answers pricing safely without inventing a quote and asks one useful next question", () => {
    const policy = evaluateSmsTurnPolicy({
      customerMessage: "How much will it cost to repair?",
      business: business(),
      lead: {
        serviceNeeded: "clogged toilet",
        urgency: "medium",
      },
    });

    expect(policy.directResult.messageCategory).toBe("pricing_request");
    expect(policy.directResult.reply).not.toMatch(/\$\s*\d/);
    expect(policy.directResult.reply).toMatch(
      /active leak|overflow|loss of service|safety/i,
    );
  });

  it("handles pricing + scheduling in one turn without dropping either intent", () => {
    const policy = evaluateSmsTurnPolicy({
      customerMessage: "How much is it and can you come tomorrow at 9am?",
      business: business(),
      lead: { serviceNeeded: "clogged toilet" },
      now: new Date("2026-08-17T20:00:00-05:00"),
    });

    expect(policy.intent.pricing).toBe(true);
    expect(policy.intent.scheduling).toBe(true);
    expect(policy.directResult.reply).toMatch(/pricing|cost/i);
    expect(policy.directResult.reply).toMatch(/Tuesday, Aug 18 at 9:00 AM/i);
    expect(policy.directResult.preferredAppointmentTime).toContain("tomorrow at 9am");
  });

  it("does not mistake 'can someone come tomorrow' for a human-agent request", () => {
    const policy = evaluateSmsTurnPolicy({
      customerMessage: "Can someone come tomorrow at 9?",
      business: business(),
      lead: { serviceNeeded: "clogged toilet" },
      now: new Date("2026-08-17T20:00:00-05:00"),
    });

    expect(policy.intent.human).toBe(false);
    expect(policy.intent.scheduling).toBe(true);
  });

  test.each([
    ["I want to talk to a person", "human_requested"],
    ["Where is the technician?", "appointment_status"],
    ["Cancel my appointment", "appointment_cancellation"],
    ["Can we reschedule to another day?", "appointment_reschedule"],
  ])("escalates operational request: %s", (message, category) => {
    const policy = evaluateSmsTurnPolicy({
      customerMessage: message,
      business: business(),
      lead: {},
    });

    expect(policy.directResult.messageCategory).toBe(category);
    expect(policy.directResult.shouldAlertOwner).toBe(true);
  });

  it("captures multi-intent service + schedule without losing the known service", () => {
    const message = "My toilet is clogged. Can you come tomorrow at 9?";
    const policy = evaluateSmsTurnPolicy({
      customerMessage: message,
      business: business(),
      lead: { serviceNeeded: "clogged toilet" },
    });

    expect(policy.intent.scheduling).toBe(true);
    expect(policy.directResult.preferredAppointmentTime).toBe(message);
    expect(policy.directResult.serviceNeeded).toBe("clogged toilet");
  });
});
