import fs from "node:fs";
import path from "node:path";

const read = (relative) =>
  fs.readFileSync(path.join(process.cwd(), relative), "utf8");

describe("voice conversation experience regression", () => {
  test("caller activity pauses termination and replies re-arm after playback grace", () => {
    const source = read("src/voice/conversationRelay.server.js");
    expect(source).toContain("const DEFAULT_IDLE_END_MS = 45_000;");
    expect(source).toContain("const estimatedPlaybackMs = boundedInteger(");
    expect(source).toContain("if (!result?.handoff) armIdleTimersAfterReply(reply);");
    expect(source).toContain(
      "armIdleTimersAfterReply(configuredGreeting || defaultGreeting);",
    );
    expect(source).toMatch(
      /message\.type === "prompt"[\s\S]{0,500}clearIdleTimers\(\);[\s\S]{0,250}message\.last !== true/,
    );
    expect(source).toMatch(
      /message\.type === "interrupt"[\s\S]{0,350}clearIdleTimers\(\)/,
    );
  });

  test("spoken business hours omit the internal timezone identifier", () => {
    const source = read("src/voice/voiceAvailability.service.js");
    expect(source).toContain(
      "The published business hours are " + "$" + "{text}.",
    );
    expect(source).not.toContain(
      "The published business hours are " + "$" + "{text}, in " + "$" + "{",
    );
  });

  test("unmatched questions receive several guided turns before callback recovery", () => {
    const source = read("src/voice/voiceAgent.service.js");
    expect(source).toContain("MAX_UNMATCHED_TURNS_BEFORE_CALLBACK = 4");
    expect(source).toContain(
      "guard.fallbackTurnCount >= MAX_UNMATCHED_TURNS_BEFORE_CALLBACK",
    );
  });
});
