jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/helpers/ai/aiGuardrails.js", () => {
  const actual = jest.requireActual("../../src/helpers/ai/aiGuardrails.js");
  return {
    __esModule: true,
    ...actual,
    evaluateDeterministicInboundGuardrails: jest.fn(),
  };
});

import OpenAI from "openai";
import { evaluateDeterministicInboundGuardrails } from "../../src/helpers/ai/aiGuardrails.js";
import {
  resetFollowUpOpenAIClient,
  runFollowUpAgent,
} from "../../src/helpers/ai/followUpAgent.js";

const mockResponsesCreate = jest.fn();
const mockOpenAIConstructor = OpenAI;
const mockEvaluateDeterministicInboundGuardrails =
  evaluateDeterministicInboundGuardrails;

const modelResult = (overrides = {}) => ({
  decision: "send",
  actionType: "request_information",
  messageCategory: "service_request",
  reply: "What service do you need help with?",
  serviceNeeded: "plumbing",
  urgency: "medium",
  address: "",
  preferredAppointmentTime: "",
  leadQualityScore: 60,
  estimatedValue: 0,
  summary: "Customer needs plumbing help.",
  shouldAlertOwner: false,
  alertPriority: "low",
  alertTitle: "",
  alertMessage: "",
  riskFlags: [],
  confidence: 90,
  ...overrides,
});

const output = (value) => ({
  output_text: typeof value === "string" ? value : JSON.stringify(value),
});

describe("followUpAgent hardening", () => {
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenAIConstructor.mockImplementation(() => ({
      responses: { create: mockResponsesCreate },
    }));
    resetFollowUpOpenAIClient();
    process.env.OPENAI_API_KEY = "test-openai-key";
    mockEvaluateDeterministicInboundGuardrails.mockReturnValue({ handled: false });
  });

  afterEach(() => {
    resetFollowUpOpenAIClient();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  test("uses deterministic emergency handling without calling OpenAI", async () => {
    mockEvaluateDeterministicInboundGuardrails.mockReturnValueOnce({
      handled: true,
      decision: "alert_owner",
      actionType: "send_fixed_response",
      category: "emergency",
      reply: "Leave the area and contact emergency services if there is immediate danger.",
      shouldAlertOwner: true,
      alertPriority: "critical",
      riskFlags: ["safety_hazard"],
      reason: "emergency safety condition",
    });

    const result = await runFollowUpAgent({
      businessName: "Atlanta Pro Plumbing",
      customerMessage: "I smell gas in the house and feel unsafe.",
      recentMessages: [],
    });

    expect(result.guardrail.skipAI).toBe(true);
    expect(result.messageCategory).toBe("emergency");
    expect(result.shouldAlertOwner).toBe(true);
    expect(mockOpenAIConstructor).not.toHaveBeenCalled();
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });

  test("fails closed when the OpenAI key is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(
      runFollowUpAgent({
        businessName: "Test Plumbing",
        customerMessage: "My sink is leaking.",
      }),
    ).rejects.toThrow("OPENAI_API_KEY is missing");
  });

  test("rejects malformed structured model output", async () => {
    mockResponsesCreate.mockResolvedValueOnce(output("{not-json"));
    await expect(
      runFollowUpAgent({
        businessName: "Test Plumbing",
        customerMessage: "My sink is leaking.",
      }),
    ).rejects.toThrow("valid structured data");
  });

  test("rejects a model response with no output text", async () => {
    mockResponsesCreate.mockResolvedValueOnce({});
    await expect(
      runFollowUpAgent({
        businessName: "Test Plumbing",
        customerMessage: "My sink is leaking.",
      }),
    ).rejects.toThrow("No AI follow-up response returned");
  });

  test("normalizes enums, ranges, and unrecognized risk flags", async () => {
    mockResponsesCreate.mockResolvedValueOnce(
      output(
        modelResult({
          urgency: "impossible",
          leadQualityScore: 999,
          estimatedValue: -100,
          confidence: 150,
          riskFlags: ["safety_hazard", "invented_flag"],
          shouldAlertOwner: false,
        }),
      ),
    );

    const result = await runFollowUpAgent({
      businessName: "Test Plumbing",
      customerMessage: "I have a plumbing bill question.",
    });

    expect(result.urgency).toBe("medium");
    expect(result.leadQualityScore).toBe(100);
    expect(result.estimatedValue).toBe(0);
    expect(result.confidence).toBe(100);
    expect(result.riskFlags).toContain("safety_hazard");
    expect(result.riskFlags).not.toContain("invented_flag");
    expect(result.shouldAlertOwner).toBe(true);
  });

  test("redacts sensitive content from the model input", async () => {
    mockResponsesCreate.mockResolvedValueOnce(output(modelResult()));

    await runFollowUpAgent({
      businessName: "Test Plumbing",
      customerMessage: "My sink still leaks. What should I do next?",
      recentMessages: [
        {
          direction: "inbound",
          body: "Use card 4111 1111 1111 1111 if needed.",
        },
        {
          direction: "inbound",
          body: "Previous card was 5555 5555 5555 4444.",
        },
      ],
    });

    const request = mockResponsesCreate.mock.calls[0][0];
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("4111 1111 1111 1111");
    expect(serialized).not.toContain("5555 5555 5555 4444");
  });

  test("does not preserve an unsupported confirmed-booking claim", async () => {
    mockResponsesCreate.mockResolvedValueOnce(
      output(
        modelResult({
          actionType: "collect_appointment_preference",
          messageCategory: "appointment_preference",
          reply: "Your appointment is booked and confirmed for 2 PM tomorrow.",
        }),
      ),
    );

    const result = await runFollowUpAgent({
      business: {
        businessName: "Test Plumbing",
        featureSettings: { aiBookingEnabled: false },
      },
      businessName: "Test Plumbing",
      customerMessage: "Tomorrow at 2 works for me.",
    });

    expect(result.decision).toBe("send_fixed_response");
    expect(
      /\b(booked|confirmed)\b/i.test(result.reply) &&
        /2\s*PM/i.test(result.reply),
    ).toBe(false);
  });
  test("V4 recovery boundary reaches follow-up guardrail", async () => {
    const activityWindowStartAt = new Date("2026-09-05T13:48:10.583Z");
    mockResponsesCreate.mockResolvedValueOnce(output(modelResult()));

    await runFollowUpAgent({
      businessName: "Test Plumbing",
      customerMessage: "My sink is clogged",
      recentMessages: [
        {
          direction: "inbound",
          body: "My sink is clogged",
          createdAt: new Date("2026-09-04T12:00:00.000Z"),
        },
      ],
      activityWindowStartAt,
    });

    expect(mockEvaluateDeterministicInboundGuardrails).toHaveBeenCalledWith(
      expect.objectContaining({
        customerMessage: "My sink is clogged",
        activityWindowStartAt,
      }),
    );
  });

});
