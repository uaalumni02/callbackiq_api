/*
 * Regression suite built from a real end-to-end SMS acceptance transcript
 * (Sep 17, 2026). Includes regression cases and controls that must remain supported.
 */
import { detectSafetyHazardType } from "../../src/helpers/ai/aiGuardrails.js";
import { extractCustomerAddress } from "../../src/services/booking/customerAddress.service.js";
import { classifySmsIntent, extractService } from "../../src/services/messaging/smsIntentClassifier.service.js";
import { findDateRange } from "../../src/services/booking/appointmentPreferenceParser.service.js";
import { captureTurnFacts } from "../../src/services/booking/turnFactCapture.service.js";

const TZ = "America/New_York";
const NOW = new Date("2026-09-17T21:41:00-04:00"); // Thursday
const FIRST_MESSAGE =
  "My kitchen sink is clogged there is no leaking or flooding. I'm Jordan Bell and my address is 56566 Road Way Atlanta Ga 30323. Can someone come next Tuesday between 2p and 4p";

describe("false emergencies: negated hazards must not alarm customers", () => {
  test.each([
    FIRST_MESSAGE,
    "My kitchen sink is clogged. There is no leaking or flooding.",
    "my kitchen sink is clogged there is no leaking or flooding",
    "kitchen faucet drips, nothing is flooded",
    "the bathroom sink drains slow, not flooded or anything",
    "bathroom isn't flooded yet",
    "no leaking and no flooding in the bathroom",
    "My toilet is clogged but it is not overflowing.",
    "My sink is clogged but there is no flooding",
    "the toilet is not overflowing",
    "water is not pouring anymore",
    "there's no fire or smoke, just a broken outlet",
    "I don't smell gas.",
  ])("not an emergency: %s", (message) => {
    expect(detectSafetyHazardType(message)).toBe("");
  });
});

describe("missed emergencies: a negation elsewhere must never hide a real hazard", () => {
  test.each([
    ["There is no flooding but water is now pouring across the kitchen floor", "flood"],
    ["no the kitchen is flooding", "flood"],
    ["No, the kitchen is flooding", "flood"],
    ["My basement has no power and is flooded", "flood"],
    ["the water won't stop and it's everywhere", "flood"],
    ["water can't stop coming out of the pipe its rising", "flood"],
    ["There was no flooding earlier, but now it is flooding the kitchen.", "flood"],
    ["my basement is flooded", "flood"],
    ["toilet overflowing onto the floor", "flood"],
    ["No, I smell gas.", "gas"],
    ["not only smoke but flames coming from the panel", "fire"],
  ])("%s -> %s", (message, hazard) => {
    expect(detectSafetyHazardType(message)).toBe(hazard);
  });
});

describe("intake facts from a single long message", () => {
  test("the address stops at the ZIP code", () => {
    expect(extractCustomerAddress(FIRST_MESSAGE)).toBe("56566 Road Way Atlanta Ga 30323");
  });
  test("a unit after the ZIP is kept", () => {
    expect(extractCustomerAddress("123 Main St Atlanta GA 30303 Apt 4")).toBe("123 Main St Atlanta GA 30303 Apt 4");
  });
  test("'next Tuesday' on a Thursday is the coming Tuesday", () => {
    expect(findDateRange("next Tuesday between 2p and 4p", TZ, NOW)).toEqual({ startDate: "2026-09-22", endDate: "2026-09-22" });
  });
  test("'next Friday' on a Monday is the Friday of the following week", () => {
    expect(findDateRange("next Friday", TZ, new Date("2026-09-14T10:00:00-04:00")).startDate).toBe("2026-09-25");
  });
  test("a safety turn still yields service, address and timing", () => {
    const classification = classifySmsIntent({ customerMessage: FIRST_MESSAGE, business: { timezone: TZ }, now: NOW });
    const facts = captureTurnFacts({ customerMessage: FIRST_MESSAGE, classification, lead: {}, business: { timezone: TZ }, now: NOW });
    expect(facts.address).toBe("56566 Road Way Atlanta Ga 30323");
    expect(facts.serviceNeeded).toMatch(/kitchen sink is clogged/i);
    expect(facts.preferredAppointmentTime).toMatch(/^2026-09-22/);
  });
});

describe("customer corrections", () => {
  const lead = { serviceNeeded: "My kitchen sink is clogged" };
  test("'bathroom sink and not the kitchen sink' rewrites the saved request", () => {
    expect(extractService("Actually it's the bathroom sink and not the kitchen sink. Wednesday after 3p would be better", { lead }))
      .toBe("My bathroom sink is clogged");
  });
  test("reverse order works", () => {
    expect(extractService("not the kitchen sink, the bathroom sink", { lead })).toBe("My bathroom sink is clogged");
  });
  test("a day correction is not treated as a service correction", () => {
    expect(extractService("Actually Wednesday not Tuesday", { lead })).toBe("");
  });
});
