import Message from "../../src/models/message.js";
import {
  evaluateConversationAbuse,
  isFirstAIReply,
} from "../../src/helpers/ai/aiGuardrails.js";

describe("persisted AI message counters", () => {
  const previousHourly = process.env.AI_MAX_REPLIES_PER_HOUR;
  const previousTurns = process.env.AI_MAX_TURNS_PER_CONVERSATION;

  beforeEach(() => {
    process.env.AI_MAX_REPLIES_PER_HOUR = "2";
    process.env.AI_MAX_TURNS_PER_CONVERSATION = "20";
  });

  afterAll(() => {
    if (previousHourly === undefined) delete process.env.AI_MAX_REPLIES_PER_HOUR;
    else process.env.AI_MAX_REPLIES_PER_HOUR = previousHourly;

    if (previousTurns === undefined) delete process.env.AI_MAX_TURNS_PER_CONVERSATION;
    else process.env.AI_MAX_TURNS_PER_CONVERSATION = previousTurns;
  });

  test("real Message documents with persisted metadata count toward the hourly limit", () => {
    const now = new Date("2026-07-30T18:00:00.000Z");
    const recentMessages = [
      new Message({
        direction: "outbound",
        from: "+14045550100",
        to: "+14045550101",
        body: "First AI reply",
        provider: "twilio",
        status: "sent",
        isAiGenerated: true,
        generatedBy: "ai",
        metadata: { aiGenerated: true },
        createdAt: new Date(now.getTime() - 10 * 60_000),
      }),
      new Message({
        direction: "outbound",
        from: "+14045550100",
        to: "+14045550101",
        body: "Second AI reply",
        provider: "twilio",
        status: "sent",
        isAiGenerated: true,
        generatedBy: "ai",
        metadata: { aiGenerated: true },
        createdAt: new Date(now.getTime() - 5 * 60_000),
      }),
    ];

    const result = evaluateConversationAbuse({
      customerMessage: "I have another question",
      recentMessages,
      now,
    });

    expect(result).toMatchObject({
      blocked: true,
      reason: "ai_hourly_reply_limit",
    });
    expect(isFirstAIReply(recentMessages)).toBe(false);
  });

  test("real AI Message documents count toward the conversation AI-turn limit", () => {
    process.env.AI_MAX_REPLIES_PER_HOUR = "20";
    process.env.AI_MAX_TURNS_PER_CONVERSATION = "3";
    const now = new Date("2026-07-30T18:00:00.000Z");
    const recentMessages = [1, 2, 3].map(
      (index) =>
        new Message({
          direction: "outbound",
          from: "+14045550100",
          to: "+14045550101",
          body: `AI reply ${index}`,
          provider: "twilio",
          status: "sent",
          isAiGenerated: true,
          generatedBy: "ai",
          metadata: { aiGenerated: true },
          createdAt: new Date(now.getTime() - index * 5 * 60_000),
        }),
    );

    expect(
      evaluateConversationAbuse({
        customerMessage: "One more message",
        recentMessages,
        now,
      }),
    ).toMatchObject({
      blocked: true,
      reason: "conversation_ai_turn_limit",
    });
  });

  test("non-AI outbound messages do not consume the AI reply counter", () => {
    const now = new Date("2026-07-30T18:00:00.000Z");
    const recentMessages = [
      new Message({
        direction: "outbound",
        from: "+14045550100",
        to: "+14045550101",
        body: "Manual owner response",
        provider: "manual",
        status: "sent",
        generatedBy: "user",
        actorType: "user",
        createdAt: new Date(now.getTime() - 5 * 60_000),
      }),
    ];

    expect(
      evaluateConversationAbuse({
        customerMessage: "Thank you",
        recentMessages,
        now,
      }),
    ).toMatchObject({ blocked: false });
    expect(isFirstAIReply(recentMessages)).toBe(true);
  });
});
