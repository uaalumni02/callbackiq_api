import {
  conversationRelayTwiml,
  isConversationRelayConfigured,
  normalizeVoiceSettings,
} from "../../src/voice/voiceRouting.service.js";

describe("Phase 9 voice routing", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      VOICE_HTTP_PUBLIC_URL: "https://api.callbackiq.com",
      VOICE_WEBSOCKET_PUBLIC_URL: "wss://api.callbackiq.com/ws/voice",
      TWILIO_AUTH_TOKEN: "token",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("requires a secure websocket and Twilio signature secret", () => {
    expect(isConversationRelayConfigured()).toBe(true);
    process.env.VOICE_WEBSOCKET_PUBLIC_URL = "ws://localhost/ws/voice";
    expect(isConversationRelayConfigured()).toBe(false);
    process.env.VOICE_WEBSOCKET_PUBLIC_URL = "wss://api.callbackiq.com/ws/voice";
    process.env.VOICE_HTTP_PUBLIC_URL = "http://api.callbackiq.com";
    expect(isConversationRelayConfigured()).toBe(false);
  });

  test("builds scoped ConversationRelay TwiML", () => {
    const business = {
      _id: "business-1",
      businessName: "Peachtree Plumbing",
      features: { voiceAiEnabled: true },
      voiceSettings: {
        answerMode: "after_hours",
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
    expect(twiml).toContain('name="voiceSessionId"');
  });

  test("uses the forwarding phone as a transfer fallback", () => {
    expect(
      normalizeVoiceSettings({
        forwardingPhone: "+14045550100",
        features: {},
        voiceSettings: {},
      }).transferPhone,
    ).toBe("+14045550100");
  });
});
