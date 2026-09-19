import {
  shouldCompleteManualIntake,
  buildFailedHumanHandoffUpdate,
  buildFinalizedHumanHandoffUpdate,
  buildHumanHandoffAcknowledgement,
  buildHumanHandoffStatusAcknowledgement,
  buildHumanHandoffStatusResult,
  buildPendingHumanHandoffUpdate,
  ensureHumanHandoffResult,
  ensureUrgentOperationalResult,
  isHumanHandoffSource,
  isHumanHandoffStatusQuestion,
  isUrgentOperationalResult,
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
    [{ messageCategory: "emergency" }, false],
    [{ messageCategory: "emergency", riskFlags: ["safety_hazard"] }, true],
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
    expect(result.reply).toMatch(/flagged|callback request/i);
    expect(result.reply).toMatch(/can't guarantee/i);
    expect(result.reply).not.toMatch(/correct shutoff/i);
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.guardrail.skipAI).toBe(true);
    expect(result.handoff.acknowledgementRequired).toBe(true);
  });


  it("keeps a high-priority water leak in automation while alerting the owner", () => {
    const baseResult = {
      messageCategory: "emergency",
      urgency: "high",
      serviceNeeded: "water heater leak",
      reply: "The team will contact you shortly.",
    };

    expect(requiresHumanHandoff(baseResult)).toBe(false);
    expect(isUrgentOperationalResult(baseResult)).toBe(true);

    const result = ensureUrgentOperationalResult({
      result: baseResult,
      business,
      lead: { ...lead, address: "" },
      customerMessage: "My hot water heater is leaking.",
    });

    expect(result.shouldAlertOwner).toBe(true);
    expect(result.alertPriority).toBe("high");
    expect(result.reply).not.toMatch(/flagged this as urgent/i);
    expect(result.reply).toMatch(/service address/i);
    expect(result.reply).not.toMatch(/will contact you shortly/i);
  });

  it("preserves a safe requested rough estimate during an urgent water response", () => {
    const baseResult = {
      messageCategory: "emergency",
      urgency: "high",
      serviceNeeded: "leaking pipe",
      address: "123 Peachtree Street, Atlanta GA 30318",
      preferredAppointmentTime: "tomorrow",
      reply:
        "A rough estimate is $250. Final price can vary after an onsite assessment. I can also help with available appointment times.",
    };

    const result = ensureUrgentOperationalResult({
      result: baseResult,
      business,
      lead: {
        ...lead,
        address: "123 Peachtree Street, Atlanta GA 30318",
        preferredAppointmentTime: "tomorrow",
      },
      customerMessage:
        "I have a leaking pipe. It is urgent. What might it cost, and can I book someone?",
    });

    expect(result.reply).not.toMatch(/flagged this as urgent/i);
    expect(result.reply).toMatch(/rough estimate/i);
    expect(result.reply).toMatch(/final price can vary/i);
    expect(result.reply).toMatch(/appointment/i);
    expect(result.reply).not.toMatch(/team will call/i);
    expect(result.reply).not.toMatch(/contact you shortly/i);
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

    expect(update["orchestration.phase"]).toBe("handoff_pending");
    expect(update["orchestration.handoffStatus"]).toBe("pending_ack");
    expect(update["orchestration.handoffRequestedAt"]).toBe(requestedAt);
    expect(update.aiEnabled).toBeUndefined();
    expect(update.humanTakeover).toBeUndefined();
  });

  it("keeps AI ownership unchanged after the acknowledgement receives a durable outcome", () => {
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

    expect(update.aiEnabled).toBeUndefined();
    expect(update.humanTakeover).toBeUndefined();
    expect(update["orchestration.phase"]).toBeUndefined();
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

  it("keeps a callback acknowledgement separate from the safety policy", () => {
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

    expect(reply).toMatch(/callback request/i);
    expect(reply).toMatch(/can't guarantee/i);
    expect(reply).not.toMatch(/correct shutoff/i);
    expect(reply.length).toBeLessThanOrEqual(320);
  });
});


describe("manual intake completion boundaries", () => {
  const ready = { serviceNeeded: "Sink clogged", urgency: "high", address: "123 Main Street", preferredAppointmentTime: "Wednesday at 9 AM" };
  const result = { intakeReady: true, decision: "send_fixed_response", messageCategory: "appointment_preference", guardrail: { usedFallback: false } };
  test.each(["serviceNeeded", "urgency", "address", "preferredAppointmentTime"])("waits for missing %s", field => {
    expect(shouldCompleteManualIntake({ business, conversation, lead: { ...ready, [field]: "" }, result })).toBe(false);
  });
  test("does not interrupt an enabled booking workflow or an active slot offer", () => {
    expect(shouldCompleteManualIntake({ business: { ...business, features: { aiBookingEnabled: true } }, conversation, lead: ready, result })).toBe(false);
    expect(shouldCompleteManualIntake({ business, conversation: { ...conversation, bookingState: { status: "offering_slots" } }, lead: ready, result })).toBe(false);
    expect(shouldCompleteManualIntake({ business, conversation, lead: ready, result })).toBe(true);
  });
});


test('pending acknowledgement is not proof of a durable review request', () => {
 const result=buildHumanHandoffStatusResult({business,conversation:{orchestration:{handoffReason:'intake_complete',handoffStatus:'pending_ack'}}});
 expect(result.reply).toMatch(/staff review has not been verified/);
 expect(result.reply).not.toMatch(/saved for team review|flagged/);
});
