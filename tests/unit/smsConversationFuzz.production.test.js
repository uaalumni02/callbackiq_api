import { classifySmsIntent } from "../../src/services/messaging/smsIntentClassifier.service.js";

const rng = (seed) => {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
};
const pick = (random, values) => values[Math.floor(random() * values.length)];

describe("SMS classifier deterministic fuzz corpus", () => {
  test("5,000 generated variants preserve core intent invariants", () => {
    const random = rng(0xCB1A2026);
    const greetings = ["", "hey ", "hi ", "ok ", "please "];
    const punctuation = ["", ".", "!", "??", " ..."];
    const scheduleDays = ["tomorrow", "Friday", "Monday morning", "after work tomorrow"];
    const humanPhrases = ["I want to talk to a person", "transfer me to a human", "have someone call me"];
    const schedulePhrases = ["can someone come tomorrow", "can you come Friday", "Monday morning works"];

    for (let index = 0; index < 5000; index += 1) {
      const explicitHuman = random() < 0.45;
      const base = explicitHuman ? pick(random, humanPhrases) : pick(random, schedulePhrases);
      const message = pick(random, greetings) + base + (random() < 0.25 ? ` ${pick(random, scheduleDays)}` : "") + pick(random, punctuation);
      const result = classifySmsIntent({
        customerMessage: message,
        business: { timezone: "America/New_York" },
        now: new Date("2026-09-01T12:00:00Z"),
      });
      if (explicitHuman) expect(result.intents.human).toBe(true);
      else {
        expect(result.intents.human).toBe(false);
        expect(result.intents.scheduling).toBe(true);
      }
    }
  });
});
