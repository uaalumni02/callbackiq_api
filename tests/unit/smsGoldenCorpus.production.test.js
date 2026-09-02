import fs from "node:fs";
import path from "node:path";
import { classifySmsIntent } from "../../src/services/messaging/smsIntentClassifier.service.js";

const corpus = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), "tests/fixtures/smsConversationGolden.json"),
    "utf8",
  ),
);

describe("SMS golden conversation-turn corpus", () => {
  test("contains at least 300 release-blocking golden cases", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(300);
  });

  test.each(corpus)("$id: $message", ({ message, expected }) => {
    const result = classifySmsIntent({
      customerMessage: message,
      business: { timezone: "America/New_York" },
      now: new Date("2026-09-01T12:00:00Z"),
    });
    expect(result.primaryIntent).toBe(expected.primaryIntent);
    expect(result.intents.human).toBe(expected.human);
    expect(result.intents.scheduling).toBe(expected.scheduling);
  });
});
