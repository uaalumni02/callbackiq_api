export { validateConversationRelaySignature } from './relay/context.js';
import { createRelayConnectionHandler } from './relay/connection.js';
import { DEFAULT_CLOSE_DELAY_MS, DEFAULT_END_DELAY_MS, DEFAULT_HANDSHAKE_TIMEOUT_MS, DEFAULT_HARD_TURN_TIMEOUT_MS, DEFAULT_IDLE_END_MS, DEFAULT_IDLE_FIRST_MS, DEFAULT_IDLE_SECOND_MS, DEFAULT_MAX_PENDING_PER_IP, DEFAULT_SOFT_TURN_TIMEOUT_MS, MAX_FRAME_BYTES, PATH, VoiceAgentService, VoiceCapacityService, VoiceConnectionLeaseService, VoiceFailureService, VoiceFraudDetectionService, VoiceMetricsService, VoiceOutcomeService, VoiceSessionService, VoiceTranscriptService, VoiceUsageService, WebSocketServer, acquireFleetVoiceSlot, boundedInteger, createVoiceAdmission, isPhase9ForcedRelayFailureEnabled, logOperationalError, logOperationalWarning, registerVoiceSnapshot, rejectUpgrade, resolveTrustedRemoteAddress, runVoiceConversationTurn, validateConversationRelaySignature, withDeadline } from './relay/context.js';

export const initializeConversationRelayServer = (
  httpServer,
  {
    admissionController = createVoiceAdmission(),
    voiceAgentService = VoiceAgentService,
    coordinateConversationTurn = runVoiceConversationTurn,
    voiceSessionService = VoiceSessionService,
    voiceTranscriptService = VoiceTranscriptService,
    voiceFailureService = VoiceFailureService,
    voiceCapacityService = VoiceCapacityService,
    voiceUsageService = VoiceUsageService,
    voiceFraudDetectionService = VoiceFraudDetectionService,
    voiceConnectionLeaseService = VoiceConnectionLeaseService,
    voiceOutcomeService = VoiceOutcomeService,
    voiceMetricsService = VoiceMetricsService,
    signatureValidator = validateConversationRelaySignature,
    failureEndDelayMs = DEFAULT_END_DELAY_MS,
    failureCloseDelayMs = DEFAULT_CLOSE_DELAY_MS,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    idleFirstMs = DEFAULT_IDLE_FIRST_MS,
    idleSecondMs = DEFAULT_IDLE_SECOND_MS,
    idleEndMs = DEFAULT_IDLE_END_MS,
    softTurnTimeoutMs = DEFAULT_SOFT_TURN_TIMEOUT_MS,
    hardTurnTimeoutMs = DEFAULT_HARD_TURN_TIMEOUT_MS,
    durationLimitMs = null,
    maxPendingConnectionsPerIp = boundedInteger(
      process.env.VOICE_WS_MAX_PENDING_PER_IP,
      DEFAULT_MAX_PENDING_PER_IP,
      1,
      50,
    ),
    forceFailureAfterSetup = isPhase9ForcedRelayFailureEnabled(),
  } = {},
) => {
  const cleanupTasks = new Set();
  registerVoiceSnapshot(admissionController.snapshot);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const upgradeHandler = async (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url || "", "http://localhost").pathname;
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (pathname !== PATH) return;

    let signatureIsValid = false;
    try {
      signatureIsValid = signatureValidator(request);
    } catch (error) {
      logOperationalError(
        "conversation_relay.signature_validation_failed",
        error,
      );
    }
    if (!signatureIsValid) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const localLease = admissionController.acquireConnection();
    if (!localLease) { rejectUpgrade(socket, 503, "Service Unavailable"); return; }
    let releaseFleet = async () => {};
    socket.once("close", () => { localLease.release(); void releaseFleet(); });
    const ip = resolveTrustedRemoteAddress(request);
    let admission;
    try {
      releaseFleet = await acquireFleetVoiceSlot();
      if (socket.destroyed) { await releaseFleet(); localLease.release(); return; }
      admission = await voiceConnectionLeaseService.acquireVoiceConnectionLease({
        remoteAddress: ip,
        limit: maxPendingConnectionsPerIp,
      });
    } catch (error) {
      logOperationalError("conversation_relay.connection_lease_acquire_failed", error, {
        remoteAddress: ip,
      });
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    if (!admission?.allowed) {
      logOperationalWarning("conversation_relay.pending_ip_limit", { remoteAddress: ip });
      rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }

    try {
      wss.handleUpgrade(request, socket, head, (webSocket) => {
        wss.emit("connection", webSocket, request, { ip, lease: admission.lease, localLease });
      });
    } catch (error) {
      await voiceConnectionLeaseService.releaseVoiceConnectionLease(admission.lease).catch(() => {});
      logOperationalError("conversation_relay.upgrade_failed", error, {
        remoteAddress: ip,
      });
      rejectUpgrade(socket, 500, "Internal Server Error");
    }
  };

  httpServer.on("upgrade", upgradeHandler);

  wss.on("connection", createRelayConnectionHandler({ admissionController, cleanupTasks, coordinateConversationTurn, durationLimitMs, failureCloseDelayMs, failureEndDelayMs, forceFailureAfterSetup, handshakeTimeoutMs, hardTurnTimeoutMs, idleEndMs, idleFirstMs, idleSecondMs, softTurnTimeoutMs, voiceAgentService, voiceCapacityService, voiceConnectionLeaseService, voiceFailureService, voiceFraudDetectionService, voiceMetricsService, voiceOutcomeService, voiceSessionService, voiceTranscriptService, voiceUsageService }));

  return {
    snapshot: admissionController.snapshot,
    beginDrain: () => admissionController.drain(),
    async close({ drainMs = 0 } = {}) {
      admissionController.drain();
      const deadline = Date.now() + drainMs;
      while (wss.clients.size && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
      }
      httpServer.off("upgrade", upgradeHandler);
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
      await withDeadline(Promise.allSettled([...cleanupTasks]), 5000, "VOICE_CLEANUP_TIMEOUT").catch(error => logOperationalWarning("voice.drain_cleanup_timeout", { code: error.code }));
    },
  };
};

export default initializeConversationRelayServer;
