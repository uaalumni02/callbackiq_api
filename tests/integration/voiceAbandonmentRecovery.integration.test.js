jest.mock('../../src/services/voiceConversationTurn.service.js', () => ({ runVoiceConversationTurn: ({ operation }) => operation() }));
import http from "http";
import { WebSocket } from "ws";
import initializeConversationRelayServer from "../../src/voice/conversationRelay.server.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("normal caller hangup with no outcome invokes abandonment recovery once", async () => {
  const session = {
    _id: "session-1", status: "active", from: "+14045550100", to: "+14045550200",
    business: { _id: "business-1", businessName: "Acme Plumbing", voiceSettings: { maxCallDurationSeconds: 600 } },
    metadata: {}, transcript: [], startedAt: new Date(),
  };
  const recoverAbandonedVoiceCall = jest.fn().mockResolvedValue({ recovered: true });
  const server = http.createServer((_req, res) => res.end("ok"));
  const relay = initializeConversationRelayServer(server, {
    signatureValidator: () => true,
    voiceSessionService: {
      activateFromSetup: jest.fn().mockResolvedValue(session),
      touchActivity: jest.fn(),
      sendFallbackSms: jest.fn(),
    },
    voiceTranscriptService: { append: jest.fn(), finalize: jest.fn() },
    voiceAgentService: { handlePrompt: jest.fn() },
    voiceFailureService: { record: jest.fn() },
    voiceCapacityService: { acquireVoiceCapacity: jest.fn().mockResolvedValue({ allowed: true }), releaseVoiceCapacity: jest.fn() },
    voiceConnectionLeaseService: {
      acquireVoiceConnectionLease: jest.fn().mockResolvedValue({ allowed: true, lease: { ipHash: "test-ip", leaseId: "test-lease" } }),
      releaseVoiceConnectionLease: jest.fn().mockResolvedValue(undefined),
    },
    voiceUsageService: { reserveVoiceUsage: jest.fn().mockResolvedValue({ allowed: true, reservedSeconds: 60 }), reconcileVoiceUsage: jest.fn() },
    voiceFraudDetectionService: { evaluateCallerVelocity: jest.fn().mockResolvedValue({ allowed: true }) },
    voiceOutcomeService: { inferVoiceOutcome: jest.fn().mockReturnValue(""), commitVoiceOutcome: jest.fn(), recoverAbandonedVoiceCall },
    voiceMetricsService: { recordVoiceMetric: jest.fn() },
    handshakeTimeoutMs: 1000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice`);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ type: "setup", customParameters: { voiceSessionId: "session-1" } }));
  await wait(30);
  ws.close(1000, "caller hung up");
  await wait(80);
  expect(recoverAbandonedVoiceCall).toHaveBeenCalledTimes(1);
  expect(recoverAbandonedVoiceCall).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1", closeCode: 1000 }));
  await relay.close();
  await new Promise((resolve) => server.close(resolve));
});
