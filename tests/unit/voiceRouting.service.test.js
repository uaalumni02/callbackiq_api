import {
  conversationRelayTwiml,
  getPresetRoutingPolicy,
  inferAnswerMode,
  isConversationRelayConfigured,
  isPhase9ForcedRelayFailureEnabled,
  normalizeVoiceSettings,
  routingPolicyUsesStaff,
  routingPolicyUsesVoiceAi,
} from "../../src/voice/voiceRouting.service.js";

describe("Phase 9 voice routing settings", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      VOICE_HTTP_PUBLIC_URL: "https://api.callbackiq.com",
      VOICE_WEBSOCKET_PUBLIC_URL: "wss://api.callbackiq.com/ws/voice",
      TWILIO_AUTH_TOKEN: "token",
      PHASE9_ENABLE_LIVE_TEST_HOOKS: "false",
      PHASE9_FORCE_RELAY_FAILURE: "false",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });
  test("requires secure HTTPS, WSS, and Twilio signature configuration", () => {
    expect(isConversationRelayConfigured()).toBe(true);
    process.env.VOICE_WEBSOCKET_PUBLIC_URL = "ws://localhost/ws/voice";
    expect(isConversationRelayConfigured()).toBe(false);
  });
  test("allows the forced relay failure hook only outside production", () => {
    process.env.APP_ENV = "staging";
    process.env.PHASE9_ENABLE_LIVE_TEST_HOOKS = "true";
    process.env.PHASE9_FORCE_RELAY_FAILURE = "true";
    expect(isPhase9ForcedRelayFailureEnabled()).toBe(true);

    process.env.APP_ENV = "production";
    expect(isPhase9ForcedRelayFailureEnabled()).toBe(false);
  });
  test("keeps legacy answer modes until the business saves policy version 1", () => {
    const normalized = normalizeVoiceSettings({
      features: { voiceAiEnabled: true },
      voiceSettings: { answerMode: "after_hours" },
    });

    expect(normalized.routingPolicy).toEqual(
      getPresetRoutingPolicy("after_hours"),
    );
    expect(normalized.answerMode).toBe("after_hours");
  });
  test("normalizes explicit scenario routing and identifies custom policies", () => {
    const normalized = normalizeVoiceSettings({
      features: { voiceAiEnabled: true },
      voiceSettings: {
        answerMode: "custom",
        routingPolicyVersion: 1,
        routingPolicy: {
          openHours: "staff_then_sms",
          afterHours: "sms",
          voiceFailure: "staff_then_sms",
        },
        recordingEnabled: true,
      },
    });
    expect(normalized.answerMode).toBe("custom");
    expect(normalized.recordingEnabled).toBe(false);
    expect(routingPolicyUsesStaff(normalized.routingPolicy)).toBe(true);
    expect(routingPolicyUsesVoiceAi(normalized.routingPolicy)).toBe(false);
  });

  test("recognizes presets after scenario changes", () => {
    expect(
      inferAnswerMode({
        voiceAiEnabled: true,
        routingPolicy: getPresetRoutingPolicy("overflow"),
      }),
    ).toBe("overflow");
  });
  test("builds scoped ConversationRelay TwiML without recording verbs", () => {
    const business = {
      _id: "business-1",
      businessName: "Peachtree Plumbing",
      features: { voiceAiEnabled: true },
      voiceSettings: {
        answerMode: "always",
        welcomeGreeting: "Thanks & welcome",
      },
    };
    const twiml = conversationRelayTwiml({
      business,
      voiceSessionId: "voice-session-1",
    });
    expect(twiml).toContain("<ConversationRelay");
    expect(twiml).toContain("wss://api.callbackiq.com/ws/voice");
    expect(twiml).toContain("Thanks &amp; welcome");
    expect(twiml).not.toMatch(/record/i);
  });

  test("replaces the legacy generic greeting with the matched business name", () => {
    const business = {
      _id: "6a33ff7944ce80eaef2cb543",
      businessName: "Atlanta Pro Plumbing & Drain",
      features: { voiceAiEnabled: true },
      voiceSettings: {
        answerMode: "always",
        welcomeGreeting: "Thanks for calling. How can I help you today?",
      },
    };

    const normalized = normalizeVoiceSettings(business);
    expect(normalized.welcomeGreeting).toBe(
      "Thanks for calling Atlanta Pro Plumbing & Drain. This is their automated assistant. How can I help you today? This service does not monitor emergencies or dispatch emergency help. For immediate danger, call 911.",
    );

    const twiml = conversationRelayTwiml({
      business,
      voiceSessionId: "voice-session-atlanta",
    });
    expect(twiml).toContain(
      'welcomeGreeting="Thanks for calling Atlanta Pro Plumbing &amp; Drain. This is their automated assistant. How can I help you today? This service does not monitor emergencies or dispatch emergency help. For immediate danger, call 911."',
    );
  });
});
