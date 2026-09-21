import {
  classifySmsIntent,
  isSmsAffirmative,
  isSmsNegative,
} from "../../src/services/messaging/smsIntentClassifier.service.js";

describe("production SMS intent classifier", () => {
  test("someone + availability is scheduling, not human takeover", () => {
    const result = classifySmsIntent({
      customerMessage: "Can someone come tomorrow morning?",
      business: { timezone: "America/New_York" },
      now: new Date("2026-09-01T12:00:00Z"),
    });
    expect(result.intents.scheduling).toBe(true);
    expect(result.intents.human).toBe(false);
  });

  test.each([
    "I want to talk to a person",
    "Please transfer me to a human",
    "Stop texting me a robot",
    "Have someone call me",
  ])("recognizes explicit handoff: %s", (message) => {
    expect(classifySmsIntent({ customerMessage: message }).intents.human).toBe(true);
  });

  test("incidental coming is not appointment status", () => {
    expect(classifySmsIntent({ customerMessage: "I'm coming home at 5" }).intents.status).toBe(false);
  });

  test("explicit technician ETA is appointment status", () => {
    expect(classifySmsIntent({ customerMessage: "Is the technician still coming?" }).intents.status).toBe(true);
  });

  test.each([
    "Yes, please don't be late",
    "Yes that works, no problem",
    "Sure, go ahead",
  ])("leading affirmative survives incidental negative language: %s", (message) => {
    expect(isSmsAffirmative(message)).toBe(true);
    expect(isSmsNegative(message)).toBe(false);
  });

  test.each(["No, different day", "Nope, another time", "Not that slot"])(
    "detects scheduling rejection: %s",
    (message) => expect(isSmsNegative(message)).toBe(true),
  );

  test("destructive intent outranks casual affirmative", () => {
    const result = classifySmsIntent({ customerMessage: "Sure, but I need to reschedule the appointment" });
    expect(result.primaryIntent).toBe("reschedule");
    expect(result.response.affirmative).toBe(false);
  });

  test.each([
    "I need an appointment",
    "I want to schedule service",
    "Can I book a visit?",
    "What availability do you have?",
  ])("generic booking request enters scheduling flow: %s", (message) => {
    const result = classifySmsIntent({ customerMessage: message });
    expect(result.intents.scheduling).toBe(true);
  });

  test.each([
    "What is you availability this week?",
    "What is your availability this week?",
    "What’s your availability tomorrow?",
    "Do you have anything available this week?",
    "What's your earliest opening?",
    "What times are available Friday?",
    "Are you available this weekend?",
    "Any openings after 5?",
    "When can you come out?",
  ])("recognizes availability inquiry without treating it as a selected time: %s", (message) => {
    const result = classifySmsIntent({ customerMessage: message });
    expect(result.intents.availabilityInquiry).toBe(true);
    expect(result.intents.scheduling).toBe(true);
    expect(result.primaryIntent).toBe("availability_inquiry");
  });

  test.each([
    "Friday works for me.",
    "Tomorrow afternoon.",
    "Around 3 PM Wednesday.",
    "Anytime after 5 Thursday.",
  ])("keeps actual customer preferences out of availability-inquiry intent: %s", (message) => {
    const result = classifySmsIntent({ customerMessage: message });
    expect(result.intents.availabilityInquiry).toBe(false);
    expect(result.intents.scheduling).toBe(true);
  });

  test.each(["okay", "ok", "confirm", "confirmed", "book it"])(
    "recognizes conversational confirmation: %s",
    (message) => {
      expect(isSmsAffirmative(message)).toBe(true);
      expect(isSmsNegative(message)).toBe(false);
    },
  );

  test("service extraction stops before scheduling request", () => {
    const result = classifySmsIntent({
      customerMessage: "I have a leak under the sink, can you come today?",
      business: { timezone: "America/New_York" },
    });
    expect(result.entities.serviceNeeded).toBe("a leak under the sink");
    expect(result.intents.scheduling).toBe(true);
  });
});

describe('explicit service replacement versus pronoun symptom detail', () => {
  const lead = { serviceNeeded: 'Washing machine is leaking from the wall' };
  test.each([
    ["It's actually a pipe in the wall that is leaking", 'pipe in the wall that is leaking'],
    ['It is actually the roof that is leaking', 'roof that is leaking'],
    ["Actually, it's my furnace that is broken", 'furnace that is broken'],
    ['Correction: it is the outlet that is not working', 'outlet that is not working'],
    ['I meant the pipe is leaking', 'the pipe is leaking'],
  ])('%s replaces the subject without carrying forward the old service', (customerMessage, expected) => {
    expect(classifySmsIntent({ customerMessage, lead }).entities.serviceNeeded).toBe(expected);
  });
  test.each(['It is leaking', "It's actually leaking only when used", 'It is not working'])('%s retains the existing referent', customerMessage => {
    expect(classifySmsIntent({ customerMessage, lead }).entities.serviceNeeded).toContain(lead.serviceNeeded);
  });
  test.each(['Actually tomorrow at 3pm', "It's actually 979 Bob Ross Atlanta GA 30324", 'Actually how much will it cost?', 'Pm'])('%s does not replace service', customerMessage => {
    expect(classifySmsIntent({ customerMessage, lead }).entities.serviceNeeded).toBe('');
  });
});
