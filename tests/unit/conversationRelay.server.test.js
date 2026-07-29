import twilio from "twilio";

import { validateConversationRelaySignature } from "../../src/voice/conversationRelay.server.js";

jest.mock("twilio", () => ({
  __esModule: true,
  default: {
    validateRequest: jest.fn(),
  },
}));

describe("ConversationRelay WebSocket signature validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: "production",
      TWILIO_AUTH_TOKEN: "auth-token",
      VOICE_WEBSOCKET_PUBLIC_URL: "wss://api.callbackiq.com/ws/voice",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("validates the initial handshake against the exact public WSS URL", () => {
    twilio.validateRequest.mockReturnValue(true);

    const valid = validateConversationRelaySignature({
      headers: { "x-twilio-signature": "signature" },
    });

    expect(valid).toBe(true);
    expect(twilio.validateRequest).toHaveBeenCalledWith(
      "auth-token",
      "signature",
      "wss://api.callbackiq.com/ws/voice",
      {},
    );
  });

  test("rejects a handshake when signature inputs are missing", () => {
    expect(
      validateConversationRelaySignature({ headers: {} }),
    ).toBe(false);
    expect(twilio.validateRequest).not.toHaveBeenCalled();
  });
});
