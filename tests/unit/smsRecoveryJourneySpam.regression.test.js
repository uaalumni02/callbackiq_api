import {
  evaluateConversationAbuse,
  evaluateDeterministicInboundGuardrails,
} from "../../src/helpers/ai/aiGuardrails.js";

describe("SMS recovery-journey spam scoping regression", () => {
  const NOW = new Date("2026-09-05T13:26:55.000Z");
  const JOURNEY_START = new Date("2026-09-05T13:26:50.000Z");

  const inbound = (body, createdAt) => ({
    direction: "inbound",
    body,
    createdAt: new Date(createdAt),
  });

  test("old duplicate service messages cannot silence the first reply of a new missed-call journey", () => {
    const oldHistory = [
      inbound("My sink is clogged", "2026-09-04T12:00:00.000Z"),
      inbound("My sink is clogged", "2026-09-04T13:00:00.000Z"),
      inbound("My sink is clogged", "2026-09-04T14:00:00.000Z"),
    ];
    const currentTurn = inbound("My sink is clogged", "2026-09-05T13:26:51.383Z");

    const abuse = evaluateConversationAbuse({
      customerMessage: "My sink is clogged",
      recentMessages: [...oldHistory, currentTurn],
      now: NOW,
      activityWindowStartAt: JOURNEY_START,
    });

    expect(abuse).toEqual({ blocked: false, reason: "", riskFlags: [] });

    const assessment = evaluateDeterministicInboundGuardrails({
      customerMessage: "My sink is clogged",
      recentMessages: [...oldHistory, currentTurn],
      activityWindowStartAt: JOURNEY_START,
    });

    expect(assessment.handled).toBe(false);
    expect(assessment.category).not.toBe("possible_spam");
    expect(assessment.decision).not.toBe("no_reply");
  });

  test("duplicate-loop protection still blocks repeated messages inside the current journey", () => {
    const currentJourneyMessages = [
      inbound("My sink is clogged", "2026-09-05T13:26:51.000Z"),
      inbound("My sink is clogged", "2026-09-05T13:26:52.000Z"),
      inbound("My sink is clogged", "2026-09-05T13:26:53.000Z"),
    ];

    const assessment = evaluateDeterministicInboundGuardrails({
      customerMessage: "My sink is clogged",
      recentMessages: currentJourneyMessages,
      activityWindowStartAt: JOURNEY_START,
    });

    expect(assessment.handled).toBe(true);
    expect(assessment.category).toBe("possible_spam");
    expect(assessment.decision).toBe("no_reply");
    expect(assessment.reason).toBe("duplicate_message_loop");
  });

  test("without a recovery boundary, existing conversation-wide protection remains intact", () => {
    const messages = [
      inbound("My sink is clogged", "2026-09-05T13:26:51.000Z"),
      inbound("My sink is clogged", "2026-09-05T13:26:52.000Z"),
      inbound("My sink is clogged", "2026-09-05T13:26:53.000Z"),
    ];

    const abuse = evaluateConversationAbuse({
      customerMessage: "My sink is clogged",
      recentMessages: messages,
      now: NOW,
    });

    expect(abuse.blocked).toBe(true);
    expect(abuse.reason).toBe("duplicate_message_loop");
  });
});
