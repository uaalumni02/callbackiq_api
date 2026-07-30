import http from "node:http";
import twilio from "twilio";
import { WebSocket } from "ws";

import {
  initializeConversationRelayServer,
  validateConversationRelaySignature,
} from "../../src/voice/conversationRelay.server.js";

jest.mock("twilio", () => ({
  __esModule: true,
  default: {
    validateRequest: jest.fn(),
  },
}));

const startServer = async (options) => {
  const httpServer = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const relay = initializeConversationRelayServer(httpServer, options);

  await new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  const address = httpServer.address();
  return {
    httpServer,
    relay,
    url: `ws://127.0.0.1:${address.port}/ws/voice`,
    async close() {
      await relay.close();
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
};

const collectUntil = (socket, predicate, timeoutMs = 1500) =>
  new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ConversationRelay messages: ${JSON.stringify(messages)}`));
    }, timeoutMs);

    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      messages.push(message);
      if (predicate(message, messages)) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(messages);
      }
    };

    socket.on("message", onMessage);
  });

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
    expect(validateConversationRelaySignature({ headers: {} })).toBe(false);
    expect(twilio.validateRequest).not.toHaveBeenCalled();
  });
});

describe("ConversationRelay failure termination", () => {
  test("sends an apology and end event even when fallback SMS/database work rejects", async () => {
    const session = {
      _id: "voice-session-1",
      providerCallSid: "CA123",
      providerSessionId: "relay-session-1",
      from: "+14045550100",
      to: "+14045550101",
      status: "active",
      business: { _id: "business-1" },
    };
    const voiceSessionService = {
      activateFromSetup: jest.fn().mockResolvedValue(session),
      sendFallbackSms: jest
        .fn()
        .mockRejectedValue(new Error("database unavailable")),
      markCompleted: jest.fn(),
    };
    const voiceTranscriptService = {
      append: jest.fn().mockResolvedValue(undefined),
    };
    const voiceAgentService = { handlePrompt: jest.fn() };

    const server = await startServer({
      voiceAgentService,
      voiceSessionService,
      voiceTranscriptService,
      signatureValidator: () => true,
      failureEndDelayMs: 10,
      failureCloseDelayMs: 200,
    });
    const socket = new WebSocket(server.url);

    try {
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });

      socket.send(
        JSON.stringify({
          type: "setup",
          callSid: "CA123",
          sessionId: "relay-session-1",
          from: "+14045550100",
          to: "+14045550101",
          customParameters: { voiceSessionId: "voice-session-1" },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      const received = collectUntil(socket, (message) => message.type === "end");
      socket.send(
        JSON.stringify({
          type: "error",
          description: "forced websocket failure",
        }),
      );

      const messages = await received;
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", last: true }),
          expect.objectContaining({ type: "end" }),
        ]),
      );
      expect(voiceSessionService.sendFallbackSms).toHaveBeenCalledWith({
        sessionId: "voice-session-1",
        failureReason: "forced websocket failure",
      });

      const end = messages.find((message) => message.type === "end");
      expect(JSON.parse(end.handoffData)).toEqual(
        expect.objectContaining({
          reasonCode: "voice-failure",
          voiceSessionId: "voice-session-1",
        }),
      );
    } finally {
      socket.terminate();
      await server.close();
    }
  });
});

describe("ConversationRelay configurable failure recovery", () => {
  test("does not send SMS before the configured staff-first completion callback", async () => {
    const session = {
      _id: "voice-session-staff-first",
      providerCallSid: "CA456",
      providerSessionId: "relay-session-2",
      from: "+14045550100",
      to: "+14045550101",
      status: "active",
      business: {
        _id: "business-1",
        features: { voiceAiEnabled: true },
        voiceSettings: {
          answerMode: "custom",
          routingPolicyVersion: 1,
          transferPhone: "+14045550109",
          routingPolicy: {
            openHours: "voice_ai",
            afterHours: "voice_ai",
            voiceFailure: "staff_then_sms",
          },
        },
      },
    };
    const voiceSessionService = {
      activateFromSetup: jest.fn().mockResolvedValue(session),
      sendFallbackSms: jest.fn(),
      markCompleted: jest.fn(),
    };
    const voiceFailureService = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    const server = await startServer({
      voiceAgentService: { handlePrompt: jest.fn() },
      voiceSessionService,
      voiceFailureService,
      voiceTranscriptService: { append: jest.fn().mockResolvedValue(undefined) },
      signatureValidator: () => true,
      failureEndDelayMs: 10,
      failureCloseDelayMs: 200,
    });
    const socket = new WebSocket(server.url);

    try {
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(
        JSON.stringify({
          type: "setup",
          callSid: "CA456",
          sessionId: "relay-session-2",
          from: "+14045550100",
          to: "+14045550101",
          customParameters: { voiceSessionId: "voice-session-staff-first" },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      const received = collectUntil(socket, (message) => message.type === "end");
      socket.send(
        JSON.stringify({ type: "error", description: "forced failure" }),
      );
      await received;
      expect(voiceSessionService.sendFallbackSms).not.toHaveBeenCalled();
      expect(voiceFailureService.record).toHaveBeenCalledWith({
        sessionId: "voice-session-staff-first",
        failureReason: "forced failure",
      });
    } finally {
      socket.terminate();
      await server.close();
    }
  });
});
