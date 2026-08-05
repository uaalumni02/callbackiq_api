import http from "node:http";
import { WebSocket } from "ws";

import { initializeConversationRelayServer } from "../../src/voice/conversationRelay.server.js";

const startServer = async (options) => {
  const httpServer = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  // Test-only defaults keep infrastructure guards from reaching real MongoDB models.
  const voiceFraudDetectionService =
    options?.voiceFraudDetectionService || {
      evaluateCallerVelocity: jest.fn().mockResolvedValue({
        allowed: true,
        reason: "within_test_limit",
      }),
    };
  const voiceUsageService = options?.voiceUsageService || {
    reserveVoiceUsage: jest.fn().mockResolvedValue({
      allowed: true,
      reservedSeconds: 60,
    }),
    reconcileVoiceUsage: jest.fn().mockResolvedValue(undefined),
  };
  const voiceConnectionLeaseService = options?.voiceConnectionLeaseService || {
    acquireVoiceConnectionLease: jest.fn().mockResolvedValue({
      allowed: true,
      lease: { ipHash: "test-ip", leaseId: "test-lease" },
    }),
    releaseVoiceConnectionLease: jest.fn().mockResolvedValue(undefined),
  };
  const voiceOutcomeService = options?.voiceOutcomeService || {
    inferVoiceOutcome: jest.fn().mockReturnValue(null),
    commitVoiceOutcome: jest.fn().mockResolvedValue(undefined),
    recoverAbandonedVoiceCall: jest.fn().mockResolvedValue(undefined),
  };
  const voiceMetricsService = options?.voiceMetricsService || {
    recordVoiceMetric: jest.fn().mockResolvedValue(undefined),
  };
  const relay = initializeConversationRelayServer(httpServer, {
    ...options,
    voiceFraudDetectionService,
    voiceUsageService,
    voiceConnectionLeaseService,
    voiceOutcomeService,
    voiceMetricsService,
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();

  return {
    url: `ws://127.0.0.1:${address.port}/ws/voice`,
    async close() {
      await relay.close();
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
};

const openSocket = (url) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });

const collectUntilEnd = (socket, timeoutMs = 1500) =>
  new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for voice end: ${JSON.stringify(messages)}`));
    }, timeoutMs);

    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      messages.push(message);
      if (message.type === "end") {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(messages);
      }
    };
    socket.on("message", onMessage);
  });

const setupMessage = {
  type: "setup",
  callSid: "CA-limit-test",
  sessionId: "relay-limit-test",
  from: "+14045550100",
  to: "+14045550101",
  customParameters: { voiceSessionId: "voice-session-limit-test" },
};

const makeSession = () => ({
  _id: "voice-session-limit-test",
  providerCallSid: "CA-limit-test",
  providerSessionId: "relay-limit-test",
  from: "+14045550100",
  to: "+14045550101",
  status: "active",
  business: {
    _id: "business-limit-test",
    voiceSettings: { maxConcurrentCalls: 5, maxCallDurationSeconds: 60 },
  },
});

describe("ConversationRelay voice limits", () => {
  test("capacity denial preserves the caller-safe fallback path", async () => {
    const session = makeSession();
    const voiceCapacityService = {
      acquireVoiceCapacity: jest.fn().mockResolvedValue({
        allowed: false,
        reason: "voice_concurrency_limit",
      }),
      releaseVoiceCapacity: jest.fn(),
    };
    const voiceSessionService = {
      activateFromSetup: jest.fn().mockResolvedValue(session),
      sendFallbackSms: jest.fn().mockResolvedValue(undefined),
      markCompleted: jest.fn(),
    };
    const server = await startServer({
      voiceAgentService: { handlePrompt: jest.fn() },
      voiceSessionService,
      voiceTranscriptService: { append: jest.fn().mockResolvedValue(undefined) },
      voiceCapacityService,
      signatureValidator: () => true,
      failureEndDelayMs: 5,
      failureCloseDelayMs: 100,
    });
    const socket = await openSocket(server.url);

    try {
      const received = collectUntilEnd(socket);
      socket.send(JSON.stringify(setupMessage));
      const messages = await received;

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", last: true }),
          expect.objectContaining({ type: "end" }),
        ]),
      );
      expect(voiceCapacityService.acquireVoiceCapacity).toHaveBeenCalledWith(
        expect.objectContaining({ business: session.business, session }),
      );
      expect(voiceCapacityService.releaseVoiceCapacity).not.toHaveBeenCalled();
      expect(voiceSessionService.sendFallbackSms).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session._id }),
      );
    } finally {
      socket.terminate();
      await server.close();
    }
  });

  test("duration timeout ends safely and releases the capacity lease", async () => {
    const session = makeSession();
    const voiceCapacityService = {
      acquireVoiceCapacity: jest.fn().mockResolvedValue({
        allowed: true,
        durationSeconds: 60,
      }),
      releaseVoiceCapacity: jest.fn().mockResolvedValue(undefined),
    };
    const voiceSessionService = {
      activateFromSetup: jest.fn().mockResolvedValue(session),
      sendFallbackSms: jest.fn().mockResolvedValue(undefined),
      markCompleted: jest.fn(),
    };
    const voiceOutcomeService = {
      inferVoiceOutcome: jest.fn().mockReturnValue(null),
      commitVoiceOutcome: jest.fn().mockResolvedValue(undefined),
      recoverAbandonedVoiceCall: jest.fn().mockResolvedValue(undefined),
    };
    const server = await startServer({
      voiceAgentService: { handlePrompt: jest.fn() },
      voiceSessionService,
      voiceTranscriptService: { append: jest.fn().mockResolvedValue(undefined) },
      voiceCapacityService,
      voiceOutcomeService,
      signatureValidator: () => true,
      durationLimitMs: 20,
      failureEndDelayMs: 5,
      failureCloseDelayMs: 100,
    });
    const socket = await openSocket(server.url);

    try {
      const received = collectUntilEnd(socket);
      socket.send(JSON.stringify(setupMessage));
      const messages = await received;

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", last: true }),
          expect.objectContaining({ type: "end" }),
        ]),
      );
      expect(voiceCapacityService.releaseVoiceCapacity).toHaveBeenCalledWith({
        businessId: session.business._id,
        session,
      });
      expect(voiceOutcomeService.commitVoiceOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session._id,
          outcome: "duration_limit_callback_captured",
          status: "completed",
          metadata: expect.objectContaining({ source: "duration_limit" }),
        }),
      );
      expect(voiceSessionService.sendFallbackSms).not.toHaveBeenCalled();
    } finally {
      socket.terminate();
      await server.close();
    }
  });
});
