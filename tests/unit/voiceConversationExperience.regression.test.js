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

  test("spoken business hours are contextual and omit internal timezone identifiers", () => {
    const source = read("src/voice/voiceAvailability.service.js");

    expect(source).toContain("We’re open now until ");
    expect(source).toContain(
      "We’re closed right now and reopen today at ",
    );
    expect(source).toContain(
      "Published hours show the business reopening ",
    );

    const spokenReturns = Array.from(
      source.matchAll(/return [`"]([^`"]+)[`"];/g),
      (match) => match[1],
    ).join("\n");

    expect(spokenReturns).not.toContain("America/New_York");
    expect(spokenReturns).not.toContain("${timeZone}");
  });
  test("unmatched questions receive several guided turns before callback recovery", () => {
    const source = read("src/voice/voiceAgent.service.js");
    expect(source).toContain("MAX_UNMATCHED_TURNS_BEFORE_CALLBACK = 4");
    expect(source).toContain(
      "guard.fallbackTurnCount >= MAX_UNMATCHED_TURNS_BEFORE_CALLBACK",
    );
  });
});
