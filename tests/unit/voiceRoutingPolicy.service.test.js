import {
  buildOverflowActionPath,
  determineInitialVoiceRoute,
  determinePostDialVoiceRoute,
  determineVoiceFailureRoute,
  getPostDialFallback,
  getScenarioAction,
  VOICE_ROUTE,
} from "../../src/voice/voiceRoutingPolicy.service.js";

const settings = (overrides = {}) => ({
  voiceAiEnabled: true,
  answerMode: "custom",
  transferPhone: "+14045550100",
  routingPolicy: {
    openHours: "staff_then_voice_ai",
    afterHours: "sms",
    voiceFailure: "staff_then_sms",
  },
  ...overrides,
});

describe("configurable Phase 9 routing policy", () => {
  test("chooses the business-hours and after-hours actions independently", () => {
    expect(getScenarioAction({ settings: settings(), isOpen: true })).toBe(
      "staff_then_voice_ai",
    );
    expect(getScenarioAction({ settings: settings(), isOpen: false })).toBe(
      "sms",
    );
  });

  test("rings staff only when the selected action and transfer number require it", () => {
    expect(
      determineInitialVoiceRoute({ settings: settings(), isOpen: true }),
    ).toBe(VOICE_ROUTE.DIAL_STAFF);
    expect(
      determineInitialVoiceRoute({
        settings: settings({ transferPhone: "" }),
        isOpen: true,
      }),
    ).toBe(VOICE_ROUTE.RELAY);
  });

  test("allows immediate SMS or immediate voice AI in either scenario", () => {
    const direct = settings({
      routingPolicy: {
        openHours: "sms",
        afterHours: "voice_ai",
        voiceFailure: "sms",
      },
    });

    expect(determineInitialVoiceRoute({ settings: direct, isOpen: true })).toBe(
      VOICE_ROUTE.FALLBACK_SMS,
    );
    expect(
      determineInitialVoiceRoute({ settings: direct, isOpen: false }),
    ).toBe(VOICE_ROUTE.RELAY);
  });

  test("preserves the configured post-ring fallback in the signed callback URL", () => {
    expect(getPostDialFallback("staff_then_voice_ai")).toBe("voice_ai");
    expect(getPostDialFallback("staff_then_sms")).toBe("sms");
    expect(
      buildOverflowActionPath({
        action: "staff_then_voice_ai",
        scenario: "open_hours",
      }),
    ).toContain("fallback=voice_ai");
  });

  test("uses the post-ring result without reinterpreting the business policy", () => {
    expect(
      determinePostDialVoiceRoute({
        dialStatus: "no-answer",
        fallback: "voice_ai",
      }),
    ).toBe(VOICE_ROUTE.RELAY);
    expect(
      determinePostDialVoiceRoute({
        dialStatus: "busy",
        fallback: "sms",
      }),
    ).toBe(VOICE_ROUTE.FALLBACK_SMS);
    expect(
      determinePostDialVoiceRoute({
        dialStatus: "completed",
        fallback: "voice_ai",
      }),
    ).toBe(VOICE_ROUTE.COMPLETE);
  });

  test("supports staff-first or SMS-only recovery after a voice failure", () => {
    expect(determineVoiceFailureRoute({ settings: settings() })).toBe(
      VOICE_ROUTE.DIAL_STAFF,
    );
    expect(
      determineVoiceFailureRoute({
        settings: settings({
          routingPolicy: {
            openHours: "voice_ai",
            afterHours: "voice_ai",
            voiceFailure: "sms",
          },
        }),
      }),
    ).toBe(VOICE_ROUTE.FALLBACK_SMS);
  });

  test("keeps the original Twilio flow when Phase 9 is disabled", () => {
    expect(
      determineInitialVoiceRoute({
        settings: settings({ voiceAiEnabled: false, answerMode: "disabled" }),
        isOpen: false,
      }),
    ).toBe(VOICE_ROUTE.LEGACY);
  });
});
