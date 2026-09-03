import {
  buildFailedHumanHandoffUpdate,
  buildFinalizedHumanHandoffUpdate,
  buildHumanHandoffAcknowledgement,
  buildHumanHandoffStatusAcknowledgement,
  buildHumanHandoffStatusResult,
  buildPendingHumanHandoffUpdate,
  ensureHumanHandoffResult,
  isHumanHandoffSource,
  isHumanHandoffStatusQuestion,
  requiresHumanHandoff,
  shouldSendHumanHandoffStatusAcknowledgement,
} from "../../src/services/messaging/smsHandoff.service.js";
import { evaluateSmsTurnPolicy } from "../../src/services/messaging/smsTurnPolicy.service.js";

const business = {
  _id: "business-1",
  businessName: "Atlanta Pro Plumbing & Drain",
  businessType: "plumbing",
  timezone: "America/New_York",
  features: { aiBookingEnabled: false },
};

const conversation = {
  _id: "conversation-1",
  customerPhone: "+16785768258",
  orchestration: {},
};

const lead = {
  _id: "lead-1",
  serviceNeeded: "water heater leak",
  urgency: "high",
  address: "970 Sidney Marcus Blvd NE, Atlanta, GA 30324",
};

describe("production SMS handoff", () => {
  test.each([
    [{ messageCategory: "human_requested" }, true],
    [{ messageCategory: "emergency" }, true],
    [{ riskFlags: ["safety_hazard"] }, true],
    [{ messageCategory: "appointment_preference" }, false],
  ])("detects whether a result requires handoff", (result, expected) => {
    expect(requiresHumanHandoff(result)).toBe(expected);
  });

  it("creates a useful callback acknowledgement instead of allowing silence", () => {
    const result = ensureHumanHandoffResult({
      result: {
        decision: "no_reply",
        messageCategory: "human_requested",
        reply: "",
        serviceNeeded: "water heater leak",
        urgency: "high",
      },
      business,
      lead,
      conversation,
      customerMessage:
        "Is it safe to leave it running? Please have a person call me on this number.",
    });

    expect(result.decision).toBe("send_fixed_response");
    expect(result.reply).toMatch(/call the number you're texting from/i);
    expect(result.reply).toMatch(/correct shutoff/i);
    expect(result.reply).toMatch(/electrical equipment/i);
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.guardrail.skipAI).toBe(true);
    expect(result.handoff.acknowledgementRequired).toBe(true);
  });

  it("records pending state without muting the conversation", () => {
    const requestedAt = new Date("2026-09-03T00:00:00.000Z");
    const update = buildPendingHumanHandoffUpdate({
      inboundMessageId: "message-1",
      conversation: {
        ...conversation,
        orchestration: { handoffRequestedAt: requestedAt },
      },
      result: { messageCategory: "human_requested" },
      now: new Date("2026-09-03T00:00:10.000Z"),
    });

    expect(update["orchestration.handoffStatus"]).toBe("pending_ack");
    expect(update["orchestration.handoffRequestedAt"]).toBe(requestedAt);
    expect(update.aiEnabled).toBeUndefined();
    expect(update.humanTakeover).toBeUndefined();
  });

  it("mutes AI only after the acknowledgement receives a durable outcome", () => {
    const update = buildFinalizedHumanHandoffUpdate({
      inboundMessageId: "message-1",
      outboundMessageId: "message-2",
      conversation: {
        ...conversation,
        orchestration: {
          handoffRequestedAt: new Date("2026-09-03T00:00:00.000Z"),
        },
      },
      result: { messageCategory: "human_requested" },
      deliveryStatus: "acknowledged",
      now: new Date("2026-09-03T00:00:05.000Z"),
    });

    expect(update.aiEnabled).toBe(false);
    expect(update.humanTakeover).toBe(true);
    expect(update["orchestration.handoffStatus"]).toBe("acknowledged");
    expect(update["orchestration.handoffOutboundMessage"]).toBe("message-2");
  });

  it("keeps a failed acknowledgement retryable without falsely completing takeover", () => {
    const update = buildFailedHumanHandoffUpdate({
      inboundMessageId: "message-1",
      conversation,
      result: { messageCategory: "human_requested" },
      error: new Error("temporary provider outage"),
    });

    expect(update["orchestration.handoffStatus"]).toBe("pending_ack");
    expect(update["orchestration.handoffLastError"]).toMatch(/provider outage/i);
    expect(update.aiEnabled).toBeUndefined();
    expect(update.humanTakeover).toBeUndefined();
  });

  it("identifies idempotent retries for the same inbound message", () => {
    expect(
      isHumanHandoffSource({
        conversation: {
          orchestration: { handoffInboundMessage: "message-1" },
        },
        inboundMessageId: "message-1",
      }),
    ).toBe(true);
  });

  test.each([
    "Did my callback request go through?",
    "Will someone call me?",
    "Did you get my message?",
  ])("recognizes a post-handoff status question: %s", (message) => {
    expect(isHumanHandoffStatusQuestion(message)).toBe(true);
  });

  it("throttles repeated status acknowledgements without mutating AI ownership", () => {
    expect(
      shouldSendHumanHandoffStatusAcknowledgement({ conversation }),
    ).toBe(true);
    expect(
      shouldSendHumanHandoffStatusAcknowledgement({
        conversation: {
          ...conversation,
          orchestration: {
            handoffStatusReplyAt: new Date("2026-09-03T00:00:00.000Z"),
          },
        },
        now: new Date("2026-09-03T00:05:00.000Z"),
      }),
    ).toBe(false);
  });

  it("builds a deterministic status result without re-enabling AI", () => {
    const result = buildHumanHandoffStatusResult({ business });
    expect(result.guardrail.skipAI).toBe(true);
    expect(result.handoff.statusAcknowledgement).toBe(true);
    expect(result).not.toHaveProperty("aiEnabled");
    expect(buildHumanHandoffStatusAcknowledgement({ business })).toMatch(
      /appointment time remains unconfirmed/i,
    );
  });

  it("marks non-booking time requests as unconfirmed", () => {
    const policy = evaluateSmsTurnPolicy({
      customerMessage: "Tomorrow after 2 PM works best",
      business,
      lead,
      now: new Date("2026-09-02T20:00:00.000Z"),
    });

    expect(policy.directResult.reply).toMatch(/not a confirmed appointment/i);
  });

  it("combines human callback confirmation with cautious plumbing safety guidance", () => {
    const reply = buildHumanHandoffAcknowledgement({
      business,
      lead,
      conversation,
      result: {
        messageCategory: "human_requested",
        serviceNeeded: "water heater leak",
        urgency: "high",
      },
      customerMessage:
        "The puddle is spreading. Is it safe to leave it running? Please call me.",
    });

    expect(reply).toMatch(/call the number you're texting from/i);
    expect(reply).toMatch(/correct shutoff/i);
    expect(reply).toMatch(/sparks, smoke, fire, or immediate danger/i);
    expect(reply.length).toBeLessThanOrEqual(320);
  });
});
