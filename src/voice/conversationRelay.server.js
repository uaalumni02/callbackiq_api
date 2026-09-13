import { withDeadline } from "../services/boundedRedis.service.js";
import { runVoiceConversationTurn } from '../services/voiceConversationTurn.service.js';
import { createVoiceAdmission, acquireFleetVoiceSlot } from "../services/voiceAdmission.service.js";
import { registerVoiceSnapshot } from "../services/runtimeState.service.js";
import {
  validateTwilioRequestWithRotation,
} from "../services/twilioSignatureRotation.service.js";
import { WebSocket, WebSocketServer } from "ws";

import VoiceAgentService from "./voiceAgent.service.js";
import VoiceFailureService from "./voiceFailure.service.js";
import VoiceSessionService from "./voiceSession.service.js";
import VoiceTranscriptService from "./voiceTranscript.service.js";
import VoiceOutcomeService from "./voiceOutcome.service.js";
import VoiceMetricsService from "./voiceMetrics.service.js";
import {
  getVoiceWebSocketUrl,
  isPhase9ForcedRelayFailureEnabled,
  normalizeVoiceSettings,
} from "./voiceRouting.service.js";
import {
  isTransientDependencyError,
  sanitizeDtmfDigits,
  toSpokenReply,
} from "./voiceInput.service.js";
import {
  determineVoiceFailureRoute,
  VOICE_ROUTE,
} from "./voiceRoutingPolicy.service.js";
import VoiceCapacityService from "../services/voiceCapacity.service.js";
import VoiceUsageService from "../services/voiceUsage.service.js";
import VoiceFraudDetectionService from "../services/voiceFraudDetection.service.js";
import VoiceConnectionLeaseService from "../services/voiceConnectionLease.service.js";
import { resolveTrustedRemoteAddress } from "../services/trustedProxyAddress.service.js";
import { runWithVoiceTurnContext } from "../services/voiceTurnContext.service.js";
import { sanitizeUnverifiedStaffCommitments } from "../services/customerCommitmentSafety.service.js";
import {
  logOperationalError,
  logOperationalWarning,
} from "../helpers/logging/safeLogger.js";

const PATH = "/ws/voice";
const DEFAULT_END_DELAY_MS = 700;
const DEFAULT_CLOSE_DELAY_MS = 3500;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
// These windows begin after the assistant returns control to the caller.
// Voice turns need more time than chat turns because TTS playback and speech
// finalization both consume part of the apparent silence window.
const DEFAULT_IDLE_FIRST_MS = 15_000;
const DEFAULT_IDLE_SECOND_MS = 30_000;
const DEFAULT_IDLE_END_MS = 45_000;
const DEFAULT_SOFT_TURN_TIMEOUT_MS = 2_500;
const DEFAULT_HARD_TURN_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PENDING_PER_IP = 5;
const DEFAULT_MAX_CALL_DURATION_SECONDS = 600;
const DEFAULT_DURATION_WARNING_SECONDS = 60;
const MAX_FRAME_BYTES = 64 * 1024;
const RECOVERABLE_RELAY_ERROR_CODES = new Set([
  "64106",
  "64107",
  "64111",
  "64112",
]);

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, Math.max(0, Number(delayMs) || 0));
  timer.unref?.();
  return timer;
};

const rejectUpgrade = (socket, statusCode, message) => {
  if (socket.destroyed) return;
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
};

const remoteAddress = (request) =>
  String(
    request.headers?.["x-forwarded-for"]?.split(",")[0] ||
      request.socket?.remoteAddress ||
      "unknown",
  )
    .trim()
    .slice(0, 100);

const signatureUrlForRequest = (request) => {
  const configured = getVoiceWebSocketUrl();
  if (!configured) return "";
  try {
    const publicUrl = new URL(configured);
    const requestUrl = new URL(request.url || PATH, "http://localhost");
    publicUrl.pathname = requestUrl.pathname;
    publicUrl.search = requestUrl.search;
    publicUrl.hash = "";
    return publicUrl.toString();
  } catch {
    return configured;
  }
};

export const validateConversationRelaySignature = (request) => {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.DISABLE_TWILIO_SIGNATURE_VALIDATION === "true"
  ) {
    return true;
  }

  const signature = request.headers?.["x-twilio-signature"];
  const publicUrl = signatureUrlForRequest(request);

  if (!signature || !publicUrl) return false;

  return validateTwilioRequestWithRotation({
    signature,
    url: publicUrl,
    params: {},
  });
};

const safeSend = (socket, payload) => {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    logOperationalError("conversation_relay.send_failed", error);
    return false;
  }
};

const getMaximumDurationSeconds = (session) =>
  boundedInteger(
    session?.business?.voiceSettings?.maxCallDurationSeconds ??
      process.env.DEFAULT_VOICE_MAX_DURATION_SECONDS,
    DEFAULT_MAX_CALL_DURATION_SECONDS,
    60,
    DEFAULT_MAX_CALL_DURATION_SECONDS,
  );

const createTurnTimeoutError = () => {
  const error = new Error(
    "The voice turn exceeded the maximum dependency-response window.",
  );
  error.code = "VOICE_TURN_TIMEOUT";
  return error;
};

const extractRelayErrorCode = (message) =>
  String(
    message?.code ||
      message?.errorCode ||
      String(message?.description || "").match(/\b(641\d{2})\b/)?.[1] ||
      "",
  );

/**
 * Attach the signed Twilio ConversationRelay transport to an HTTP server.
 * Dependencies and timings remain injectable for deterministic integration tests.
 */
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
  // CALLBACKIQ_PRODUCTION_READINESS: distributed expiring admission leases.
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

  wss.on("connection", (socket, request, connectionMeta = {}) => {
    const connectionIp = connectionMeta.ip || resolveTrustedRemoteAddress(request);
    const connectionLease = connectionMeta.lease || null;
    let session = null;
    let setupReceived = false;
    let pendingIpReleased = false;
    let pendingIpReleasePromise = null;
    let transportClosed = false;
    let intentionalEnd = false;
    let failureStarted = false;
    let capacityReserved = false;
    let voiceUsageReservedSeconds = 0;
    let voiceUsageReconciled = false;
    let usageTopUpTimer = null;
    let messageChain = Promise.resolve();
    let endTimer = null;
    let closeTimer = null;
    let handshakeTimer = null;
    let durationTimer = null;
    let durationWarningTimer = null;
    let idleTimers = [];
    let idleArmTimer = null;
    let dtmfTimer = null;
    let dtmfBuffer = "";
    let consecutiveTurnFailures = 0;
    let currentTurn = 0;
    let activeTurnController = null;
    let callerInputRevision = 0;

    const invalidateActiveTurn = () => {
      if (!activeTurnController || activeTurnController.signal.aborted) return;
      currentTurn += 1;
      const error = new Error("Caller input superseded the active voice turn.");
      error.code = "VOICE_STALE_TURN";
      activeTurnController.abort(error);
    };

    const releasePending = () => {
      /*
       * The pending-IP lease protects only the WebSocket admission/setup
       * window. Once setup succeeds, MongoDB must actually remove the lease
       * before this caller stops consuming a pending slot.
       *
       * Keep the operation idempotent and share the same promise across
       * setup, close, and timeout paths.
       */
      if (pendingIpReleasePromise) return pendingIpReleasePromise;

      pendingIpReleased = true;

      pendingIpReleasePromise = Promise.resolve(
        voiceConnectionLeaseService.releaseVoiceConnectionLease(connectionLease),
      ).catch((error) => {
        logOperationalError(
          "conversation_relay.connection_lease_release_failed",
          error,
        );
      });

      return pendingIpReleasePromise;
    };

    const assertSetupTransportOpen = () => {
      if (!transportClosed && socket.readyState === WebSocket.OPEN) return;

      const error = new Error(
        "ConversationRelay transport closed while voice setup was still in progress.",
      );
      error.code = "VOICE_TRANSPORT_CLOSED_DURING_SETUP";
      throw error;
    };

    const clearTimer = (timer) => {
      if (timer) clearTimeout(timer);
    };

    const clearIdleTimers = () => {
      clearTimer(idleArmTimer);
      idleArmTimer = null;
      for (const timer of idleTimers) clearTimer(timer);
      idleTimers = [];
    };

    const clearAllTimers = () => {
      clearTimer(endTimer);
      clearTimer(closeTimer);
      clearTimer(handshakeTimer);
      clearTimer(durationTimer);
      clearTimer(durationWarningTimer);
      clearTimer(usageTopUpTimer);
      clearTimer(dtmfTimer);
      clearIdleTimers();
      endTimer = null;
      closeTimer = null;
      handshakeTimer = null;
      durationTimer = null;
      durationWarningTimer = null;
      dtmfTimer = null;
    };

    const appendLocalTranscript = (role, text, isFinal = true) => {
      if (!session) return;
      if (!Array.isArray(session.transcript)) session.transcript = [];
      session.transcript.push({ role, text, at: new Date(), isFinal });
      if (session.transcript.length > 100) session.transcript.splice(0, 20);
    };

    const appendTranscriptSafely = async ({ role, text, isFinal = true }) => {
      if (!session?._id || !String(text || "").trim()) return;
      try {
        await voiceTranscriptService.append({
          sessionId: session._id,
          role,
          text,
          isFinal,
        });
      } catch (error) {
        logOperationalError("conversation_relay.transcript_append_failed", error, {
          businessId: session?.business?._id || session?.business,
          voiceSessionId: session?._id,
          role,
        });
      }
      appendLocalTranscript(role, text, isFinal);
    };

    const sendAssistantText = async (
      text,
      { interruptible = true, preemptible = false, record = true } = {},
    ) => {
      const spoken = toSpokenReply(text);
      if (!spoken) return false;
      const sent = safeSend(socket, {
        type: "text",
        token: spoken,
        last: true,
        interruptible,
        preemptible,
      });
      if (sent && record) {
        await appendTranscriptSafely({ role: "assistant", text: spoken });
      }
      return sent;
    };

    const releaseCapacity = async () => {
      if (!capacityReserved || !session?._id) return;
      capacityReserved = false;
      try {
        await voiceCapacityService.releaseVoiceCapacity({
          businessId: session.business?._id || session.business,
          session,
        });
      } catch (error) {
        logOperationalError("conversation_relay.capacity_release_failed", error, {
          businessId: session.business?._id || session.business,
          voiceSessionId: session._id,
        });
      }
    };

    const reconcileVoiceUsageSafely = async () => {
      if (
        voiceUsageReconciled ||
        !session?._id ||
        !voiceUsageReservedSeconds
      ) {
        return;
      }

      voiceUsageReconciled = true;

      const startedAt = new Date(
        session.startedAt || Date.now(),
      ).getTime();

      const actualSeconds = Math.max(
        1,
        Math.ceil((Date.now() - startedAt) / 1000),
      );

      try {
        const payload = {
          businessId:
            session.business?._id || session.business,
          sessionId: session._id,
          actualSeconds,
          openAiInputTokens:
            Number(session.openAiUsage?.inputTokens) || 0,
          openAiOutputTokens:
            Number(session.openAiUsage?.outputTokens) || 0,
          transferAttempts:
            Number(session.metadata?.transferAttempts) || 0,
        };

        /*
         * Production uses durable asynchronous reconciliation so call teardown
         * never launches a full Mongo transaction burst. Legacy/injected test
         * services can continue using the synchronous API.
         */
        if (
          typeof voiceUsageService.enqueueVoiceUsageReconciliation ===
          "function"
        ) {
          await voiceUsageService.enqueueVoiceUsageReconciliation(
            payload,
          );
        } else {
          await voiceUsageService.reconcileVoiceUsage(payload);
        }
      } catch (error) {
        logOperationalError(
          "conversation_relay.usage_reconciliation_failed",
          error,
          {
            businessId:
              session.business?._id || session.business,
            voiceSessionId: session._id,
          },
        );
      }
    };

    const closeTransport = (code = 1011, reason = "Voice session ended.") => {
      if (socket.readyState === WebSocket.CLOSED) return;
      try {
        socket.close(code, String(reason).slice(0, 120));
      } catch (error) {
        logOperationalError("conversation_relay.close_failed", error, {
          voiceSessionId: session?._id,
        });
        socket.terminate();
      }
    };

    const persistFallbackSafely = async (reason) => {
      if (!session?._id) return;
      try {
        const settings = normalizeVoiceSettings(session.business);
        if (
          determineVoiceFailureRoute({ settings }) === VOICE_ROUTE.DIAL_STAFF
        ) {
          await voiceFailureService.record({
            sessionId: session._id,
            failureReason: reason,
          });
          return;
        }
        await voiceSessionService.sendFallbackSms({
          sessionId: session._id,
          failureReason: reason,
        });
      } catch (error) {
        logOperationalError(
          "conversation_relay.fallback_persistence_failed",
          error,
          {
            businessId: session?.business?._id || session?.business,
            voiceSessionId: session?._id,
          },
        );
      }
    };

    const sendEndPacket = (reasonCode, reason) => {
      const sent = safeSend(socket, {
        type: "end",
        handoffData: JSON.stringify({
          reasonCode,
          reason: String(reason || "").slice(0, 1000),
          voiceSessionId: session?._id ? String(session._id) : "",
        }),
      });
      closeTimer = schedule(
        () => closeTransport(1000, "ConversationRelay handoff completed."),
        failureCloseDelayMs,
      );
      return sent;
    };

    const failGracefully = async (error, { speak = true } = {}) => {
      if (failureStarted || intentionalEnd) return;
      failureStarted = true;
      intentionalEnd = true;
      clearIdleTimers();
      clearTimer(durationTimer);
      clearTimer(durationWarningTimer);
      clearTimer(usageTopUpTimer);
      const reason = String(error?.message || "ConversationRelay failure").slice(
        0,
        2000,
      );
      logOperationalError("conversation_relay.session_failure", error, {
        businessId: session?.business?._id || session?.business,
        voiceSessionId: session?._id,
        providerCallSid: session?.providerCallSid,
        errorCode: error?.code || error?.name || "error",
      });
      if (speak) {
        await sendAssistantText(
          "I’m sorry, I’m having trouble continuing this call. I’m preserving the call record so the configured recovery workflow can follow up.",
          { interruptible: false, preemptible: true },
        );
      }
      endTimer = schedule(
        () => sendEndPacket("voice-failure", reason),
        failureEndDelayMs,
      );
      await reconcileVoiceUsageSafely();
      await releaseCapacity();
      await persistFallbackSafely(reason);
    };

    const endForNoInput = async () => {
      if (!session?._id || intentionalEnd || failureStarted) return;
      intentionalEnd = true;
      clearIdleTimers();
      await sendAssistantText(
        "I’m not hearing a response, so I’m ending the call now. I’ll preserve the call record for the configured follow-up workflow.",
        { interruptible: false, preemptible: true },
      );
      await reconcileVoiceUsageSafely();
      await releaseCapacity();
      await persistFallbackSafely("Caller provided no input after two prompts.");
      endTimer = schedule(
        () => sendEndPacket("no-input", "Caller provided no input."),
        failureEndDelayMs,
      );
    };

    const resetIdleTimers = () => {
      clearIdleTimers();
      if (!setupReceived || intentionalEnd || failureStarted) return;
      idleTimers = [
        schedule(() => {
          void sendAssistantText(
            "Are you still there? Take your time. I’m listening for your next question or service request.",
            { preemptible: true },
          );
        }, idleFirstMs),
        schedule(() => {
          void sendAssistantText(
            "I still haven’t heard anything. You can ask another question, describe the service you need, or say callback.",
            { preemptible: true },
          );
        }, idleSecondMs),
        schedule(() => {
          void endForNoInput();
        }, idleEndMs),
      ];
    };

    const armIdleTimersAfterReply = (text) => {

      clearIdleTimers();

      if (!setupReceived || intentionalEnd || failureStarted) return;

      const wordCount = String(text || "")

        .trim()

        .split(/\s+/)

        .filter(Boolean).length;

      // ConversationRelay does not expose a playback-complete frame here.

      // Delay the caller's silence window by a conservative TTS estimate.

      const estimatedPlaybackMs = boundedInteger(

        Math.ceil((wordCount / 2.4) * 1000) + 1000,

        1500,

        1500,

        30_000,

      );

      idleArmTimer = schedule(() => {

        idleArmTimer = null;

        resetIdleTimers();

      }, estimatedPlaybackMs);

    };

    const scheduleDurationLimit = () => {
      if (durationTimer || !session?._id) return;
      const maximumDurationSeconds = getMaximumDurationSeconds(session);
      const maximumMs =
        durationLimitMs == null
          ? maximumDurationSeconds * 1000
          : boundedInteger(
              durationLimitMs,
              maximumDurationSeconds * 1000,
              1000,
              DEFAULT_MAX_CALL_DURATION_SECONDS * 1000,
            );
      const warningSeconds = boundedInteger(
        process.env.VOICE_DURATION_WARNING_SECONDS,
        DEFAULT_DURATION_WARNING_SECONDS,
        15,
        120,
      );
      if (maximumMs > warningSeconds * 1000 + 5_000) {
        durationWarningTimer = schedule(() => {
          void sendAssistantText(
            `We have about ${warningSeconds} seconds left on this call. I can finish a booking step or capture a callback request.`,
            { preemptible: true },
          );
        }, maximumMs - warningSeconds * 1000);
      }
      durationTimer = schedule(() => {
        void (async () => {
          if (intentionalEnd || failureStarted) return;
          intentionalEnd = true;
          clearIdleTimers();
          await sendAssistantText(
            "We reached the call time limit. I’m saving the confirmed details for follow-up now.",
            { interruptible: false, preemptible: true },
          );
          const inferred = voiceOutcomeService.inferVoiceOutcome(session);
          await voiceOutcomeService.commitVoiceOutcome({
            sessionId: session._id,
            outcome: inferred || "duration_limit_callback_captured",
            status: "completed",
            metadata: { source: "duration_limit", maximumSeconds: Math.round(maximumMs / 1000) },
          });
          await reconcileVoiceUsageSafely();
          await releaseCapacity();
          endTimer = schedule(() => sendEndPacket("duration-limit", "Configured duration limit reached."), failureEndDelayMs);
        })().catch((error) => failGracefully(error));
      }, maximumMs);
    };

    const runAgentTurn = async (customerMessage) => {
      const turnStartedAt = Date.now();
      let settled = false;
      const turnId = ++currentTurn;
      const abortController = new AbortController();
      activeTurnController = abortController;
      const softTimer = schedule(() => {
        if (!settled && turnId === currentTurn) void sendAssistantText("One moment.", { preemptible: true });
      }, softTurnTimeoutMs);
      let hardTimer;
      let abortListener;
      try {
        const cancellationPromise = new Promise((_, reject) => {
          abortListener = () => reject(abortController.signal.reason);
          abortController.signal.addEventListener("abort", abortListener, { once: true });
        });
        const timeoutPromise = new Promise((_, reject) => {
          hardTimer = schedule(() => {
            const timeoutError = createTurnTimeoutError();
            abortController.abort(timeoutError);
            reject(timeoutError);
          }, hardTurnTimeoutMs);
        });
        const agentPromise = admissionController.runTurn(() => runWithVoiceTurnContext(
          {
            sessionId: String(session?._id || ""),
            turnId,
            signal: abortController.signal,
            isActive: () => !intentionalEnd && !failureStarted && turnId === currentTurn,
          },
          () => coordinateConversationTurn({ session, customerMessage,
            operation: () => voiceAgentService.handlePrompt({ session, customerMessage, signal: abortController.signal, turnId }) }),
        ), { signal: abortController.signal });
        const result = await Promise.race([agentPromise, timeoutPromise, cancellationPromise]);
        settled = true;
        if (turnId !== currentTurn || abortController.signal.aborted) {
          const error = new Error("A newer voice turn superseded this result.");
          error.code = "VOICE_STALE_TURN";
          throw error;
        }
        if (session?._id) void voiceMetricsService.recordVoiceMetric({ sessionId: session._id, event: "full_turn_latency_ms", value: Date.now() - turnStartedAt });
        return { result: result || {}, turnId };
      } finally {
        settled = true;
        clearTimer(softTimer);
        clearTimer(hardTimer);
        abortController.signal.removeEventListener("abort", abortListener);
      }
    };

    const processAgentInput = async (customerMessage, { source = "speech" } = {}) => {
      const text = String(customerMessage || "").trim().slice(0, 4000);
      if (!text || !session || intentionalEnd || failureStarted) return;
      // A finalized caller turn proves the caller is present. Do not let
      // no-input timers run while dependencies process the request.
      clearIdleTimers();
      const inputRevision = callerInputRevision;
      const inputFinalizedAt = Date.now();
      session.metadata = { ...(session.metadata || {}), lastInputAtMs: inputFinalizedAt };
      await appendTranscriptSafely({ role: "customer", text });
      if (source !== "dtmf" && source !== "dtmf_zero") {
        const acknowledgment = /\b(?:hola|necesito|ayuda|por favor|español|espanol)\b/i.test(text)
          ? "Entiendo."
          : "Got it.";
        await sendAssistantText(acknowledgment, { preemptible: true, record: false });
        void voiceMetricsService.recordVoiceMetric({
          sessionId: session._id,
          event: "time_to_first_audio_ms",
          value: Date.now() - inputFinalizedAt,
        });
      }
      try {
        await voiceSessionService.touchActivity?.(session._id, {
          lastInputSource: source,
          lastInputAt: new Date().toISOString(),
        });
      } catch (error) {
        logOperationalWarning("conversation_relay.activity_touch_failed", {
          voiceSessionId: session._id,
          errorCode: error?.code || error?.name || "error",
        });
      }

      if (inputRevision !== callerInputRevision) return;
      let completedTurn;
      try {
        completedTurn = await runAgentTurn(text);
      } catch (error) {
        // Barge-in is normal conversation, not a dependency failure.
        if (error?.code === "VOICE_STALE_TURN") return;
        // Do not start a second copy of a timed-out turn. Promise.race cannot
        // cancel an already-running dependency, and retrying it concurrently can
        // duplicate side effects even when downstream booking is idempotent.
        if (
          error?.code !== "VOICE_TURN_TIMEOUT" &&
          isTransientDependencyError(error)
        ) {
          try {
            completedTurn = await runAgentTurn(text);
          } catch (retryError) {
            error = retryError;
          }
        }
        if (error?.code === "VOICE_STALE_TURN") return;
        if (!completedTurn) {
          if (error?.code === "VOICE_ADMISSION_FULL") { await failGracefully(error); return; }
          consecutiveTurnFailures += 1;
          logOperationalError("conversation_relay.turn_failed", error, {
            businessId: session.business?._id || session.business,
            voiceSessionId: session._id,
            consecutiveTurnFailures,
            errorCode: error?.code || error?.name || "error",
          });
          if (consecutiveTurnFailures >= 3) {
            await failGracefully(error);
            return;
          }
          const timeout = error?.code === "VOICE_TURN_TIMEOUT";
          const recoveryReply =
            timeout
              ? "I’m sorry, that check took too long. Please say the request again, or say callback and I’ll preserve it for the team."
              : "I’m sorry, I could not complete that step. Please try once more, or say callback for team follow-up.";
          await sendAssistantText(recoveryReply, { preemptible: true });
          armIdleTimersAfterReply(recoveryReply);
          return;
        }
      }

      if (completedTurn.turnId !== currentTurn || intentionalEnd || failureStarted || transportClosed) return;
      const result = completedTurn.result;
      consecutiveTurnFailures = 0;
      const reply = sanitizeUnverifiedStaffCommitments(result?.reply, {
        channel: "voice",
      });
      if (reply) await sendAssistantText(reply);
      if (completedTurn.turnId !== currentTurn || intentionalEnd || failureStarted || transportClosed) return;
      if (result?.outcome) {
        await voiceOutcomeService.commitVoiceOutcome({ sessionId: session._id, outcome: result.outcome, metadata: { source: "voice_agent_result" } });
      }
      if (completedTurn.turnId !== currentTurn || intentionalEnd || failureStarted || transportClosed) return;
      if (!result?.handoff) armIdleTimersAfterReply(reply);
      if (result?.handoff) {
        intentionalEnd = true;
        clearIdleTimers();
        clearTimer(durationTimer);
        clearTimer(durationWarningTimer);
      clearTimer(usageTopUpTimer);
        await reconcileVoiceUsageSafely();
        await releaseCapacity();
        endTimer = schedule(() => {
          const sent = safeSend(socket, result.handoff);
          if (!sent) closeTransport(1011, "Handoff could not be delivered.");
        }, 700);
      }
    };

    const flushDtmf = async () => {
      clearTimer(dtmfTimer);
      dtmfTimer = null;
      const digits = sanitizeDtmfDigits(dtmfBuffer);
      dtmfBuffer = "";
      if (!digits) return;
      await processAgentInput(digits, { source: "dtmf" });
    };

    const handleDtmf = async (digitValue) => {
      const digit = String(digitValue || "").slice(0, 1);
      if (!/^[0-9#*]$/.test(digit)) return;
      clearIdleTimers();
      if (digit === "0" && !dtmfBuffer) {
        await processAgentInput("I want to speak to a person.", {
          source: "dtmf_zero",
        });
        return;
      }
      if (digit === "*") {
        dtmfBuffer = "";
        clearTimer(dtmfTimer);
        dtmfTimer = null;
        const digitResetReply =
          "I cleared the entered digits. Please enter them again.";
        await sendAssistantText(digitResetReply);
        armIdleTimersAfterReply(digitResetReply);
        return;
      }
      if (digit === "#") {
        await flushDtmf();
        return;
      }
      dtmfBuffer = `${dtmfBuffer}${digit}`.slice(0, 20);
      clearTimer(dtmfTimer);
      dtmfTimer = schedule(() => {
        messageChain = messageChain.then(flushDtmf).catch((error) => {
          logOperationalError("conversation_relay.dtmf_flush_failed", error, {
            voiceSessionId: session?._id,
          });
        });
      }, 1300);
    };

    const handleSetup = async (message) => {
      const voiceSessionId = message.customParameters?.voiceSessionId;
      if (!voiceSessionId) {
        throw new Error("ConversationRelay setup omitted voiceSessionId.");
      }
      if (setupReceived) {
        if (String(session?._id || "") !== String(voiceSessionId)) {
          const error = new Error("A second setup frame changed the voice session.");
          error.code = "VOICE_DUPLICATE_SETUP_MISMATCH";
          throw error;
        }
        return;
      }

      session = await voiceSessionService.activateFromSetup({
        voiceSessionId,
        setup: message,
      });

      // The peer may disconnect while MongoDB is resolving the session.
      // Never continue provisioning a call whose transport is already gone.
      assertSetupTransportOpen();

      setupReceived = true;
      connectionMeta.localLease?.activate();

      /*
       * Wait until the distributed pending-IP admission lease is actually
       * removed before continuing into full-call capacity/usage reservation.
       * Without awaiting this write, rapid connection churn can see stale
       * pending leases and incorrectly return HTTP 429.
       */
      await releasePending();

      // The distributed lease release itself is asynchronous MongoDB work.
      assertSetupTransportOpen();

      clearTimer(handshakeTimer);
      handshakeTimer = null;


      if (!session.metadata?.preflightPassedAt) {
        const velocity =
          await voiceFraudDetectionService.evaluateCallerVelocity({
            businessId:
              session.business?._id || session.business,
            callerPhone: session.from,
            maxCalls:
              session.business?.voiceSettings
                ?.callerVelocityLimitPerHour || 10,
          });

        if (!velocity.allowed) {
          const error = new Error(
            "Caller activity exceeded the voice safety limit. Callback recovery was used.",
          );
          error.code =
            velocity.reason || "VOICE_CALLER_VELOCITY_LIMIT";
          throw error;
        }
      }

      assertSetupTransportOpen();

      const capacity = await voiceCapacityService.acquireVoiceCapacity({
        business: session.business,
        session,
        settings: session.business?.voiceSettings || {},
      });
      if (capacity.allowed) {
        capacityReserved = true;
      }

      if (transportClosed || socket.readyState !== WebSocket.OPEN) {
        await releaseCapacity();
        assertSetupTransportOpen();
      }

      if (!capacity.allowed) {
        const error = new Error(
          "Voice AI capacity is temporarily unavailable. The configured recovery workflow was used.",
        );
        error.code = capacity.reason || "VOICE_CONCURRENCY_LIMIT";
        throw error;
      }

      const usage = await voiceUsageService.reserveVoiceUsage({
        business: session.business,
        sessionId: session._id,
        reserveSeconds: 60,
        reservationKey: `voice:${session._id}:initial`,
      });

      if (usage.allowed) {
        voiceUsageReservedSeconds = Number(usage.reservedSeconds) || 0;
      }

      if (transportClosed || socket.readyState !== WebSocket.OPEN) {
        // The call disappeared while usage reservation was being persisted.
        // Undo both resources before leaving setup.
        await releaseCapacity();
        await reconcileVoiceUsageSafely();
        assertSetupTransportOpen();
      }

      if (!usage.allowed) {
        const error = new Error(
          "The business voice allowance is exhausted. Callback recovery was used.",
        );
        error.code =
          usage.reason || "VOICE_ALLOWANCE_EXHAUSTED";
        throw error;
      }

      let voiceUsageTopUpSequence = 0;
      const topUpEveryMs = Math.max(30_000, Number(process.env.VOICE_USAGE_TOP_UP_INTERVAL_MS) || 45_000);
      const topUp = async () => {
        if (!session?._id || intentionalEnd || failureStarted || voiceUsageReconciled) return;
        const extra = await voiceUsageService.reserveVoiceUsage({business: session.business, sessionId: session._id, reserveSeconds: 60, reservationKey: `voice:${session._id}:topup:${++voiceUsageTopUpSequence}`});
        if (!extra.allowed) {
          const error = new Error("The voice allowance was reached during the call. The request will be preserved as a callback.");
          error.code = extra.reason || "VOICE_ALLOWANCE_EXHAUSTED_MID_CALL";
          await failGracefully(error);
          return;
        }
        voiceUsageReservedSeconds += Number(extra.reservedSeconds) || 0;
        usageTopUpTimer = schedule(() => void topUp(), topUpEveryMs);
      };
      usageTopUpTimer = schedule(() => void topUp(), topUpEveryMs);

      scheduleDurationLimit();
      const configuredGreeting = String(
        session.business?.voiceSettings?.welcomeGreeting || "",
      ).trim();
      const defaultGreeting = session.business?.businessName
        ? `Thanks for calling ${session.business.businessName}. How can I help you today?`
        : "Thanks for calling. How can I help you today?";
      armIdleTimersAfterReply(configuredGreeting || defaultGreeting);
      await appendTranscriptSafely({
        role: "system",
        text: "ConversationRelay session connected.",
      });

      /*
       * Synthetic-load readiness marker only. Never emit this packet to a
       * production Twilio ConversationRelay connection.
       */
      if (
        process.env.NODE_ENV !== "production" &&
        process.env.VOICE_LOAD_TEST_MODE === "true"
      ) {
        safeSend(socket, {
          type: "callbackiq_setup_ready",
          voiceSessionId: String(session._id),
        });
      }
      if (forceFailureAfterSetup) {
        throw new Error("Forced Phase 9 staging WebSocket failure test.");
      }
    };

    const handleRelayMessage = async (raw) => {
      if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) {
        logOperationalWarning("conversation_relay.frame_too_large", {
          voiceSessionId: session?._id,
        });
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch (error) {
        logOperationalWarning("conversation_relay.malformed_frame", {
          voiceSessionId: session?._id,
          errorCode: error?.name || "syntax_error",
        });
        return;
      }
      if (!message || typeof message !== "object") return;

      if (message.type === "setup") {
        await handleSetup(message);
        return;
      }
      if (!setupReceived || !session) {
        const error = new Error(`${message.type || "Unknown"} frame arrived before setup.`);
        error.code = "VOICE_FRAME_BEFORE_SETUP";
        throw error;
      }

      if (message.type === "prompt") {
        // A partial prompt is proof that the caller is speaking. Clear the
        // no-input timers immediately; process only the finalized transcript.
        clearIdleTimers();
        if (message.last !== true) return;
        const text = String(message.voicePrompt || "").trim();
        if (text) await processAgentInput(text, { source: "speech" });
        return;
      }
      if (message.type === "dtmf") {
        await handleDtmf(message.digit);
        return;
      }
      if (message.type === "interrupt") {
        // The caller is actively speaking. Re-arm only after the finalized
        // prompt has been processed and answered.
        clearIdleTimers();
        try {
          await voiceTranscriptService.markLastAssistantInterrupted?.(session._id);
          await voiceTranscriptService.touch?.(session._id, {
            interruptedUtterance: String(
              message.utteranceUntilInterrupt || "",
            ).slice(0, 500),
            interruptDurationMs: boundedInteger(
              message.durationUntilInterruptMs,
              0,
              0,
              600_000,
            ),
          });
        } catch (error) {
          logOperationalWarning("conversation_relay.interrupt_persistence_failed", {
            voiceSessionId: session._id,
            errorCode: error?.code || error?.name || "error",
          });
        }
        return;
      }
      /*
       * Synthetic load-test completion only.
       *
       * ConversationRelay does not provide an inbound "end" frame in the
       * protocol handled by this server. The load harness therefore needs an
       * explicit way to finish a synthetic call without making production
       * unexpected-disconnect recovery classify it as abandoned.
       *
       * This control frame is impossible to activate in production.
       */
      if (
        message.type === "callbackiq_test_complete" &&
        process.env.NODE_ENV !== "production" &&
        process.env.VOICE_LOAD_TEST_MODE === "true"
      ) {
        if (!session?._id || !setupReceived) return;

        clearAllTimers();
        clearTimer(usageTopUpTimer);

        const requestedOutcome =
          message.outcome === "caller_declined"
            ? "caller_declined"
            : "direct_answer_resolved";

        const inferred =
          voiceOutcomeService.inferVoiceOutcome(session);

        await voiceOutcomeService.commitVoiceOutcome({
          sessionId: session._id,
          outcome: inferred || requestedOutcome,
          status: "completed",
          metadata: {
            source: "synthetic_load_test",
            synthetic: true,
          },
        });

        intentionalEnd = true;

        // The transport no longer needs a live concurrency slot.
        await releaseCapacity();

        // Reconciliation only queues durable accounting work now.
        await reconcileVoiceUsageSafely();

        safeSend(socket, {
          type: "callbackiq_test_complete_ack",
          voiceSessionId: String(session._id),
        });

        closeTransport(
          1000,
          "CallBackIQ synthetic load test complete",
        );

        return;
      }

      if (message.type === "error") {
        const errorCode = extractRelayErrorCode(message);
        const error = new Error(message.description || "ConversationRelay error");
        error.code = errorCode || "CONVERSATION_RELAY_ERROR";
        if (RECOVERABLE_RELAY_ERROR_CODES.has(errorCode)) {
          logOperationalWarning("conversation_relay.recoverable_provider_error", {
            voiceSessionId: session._id,
            errorCode,
          });
          return;
        }
        throw error;
      }

      logOperationalWarning("conversation_relay.unknown_frame", {
        voiceSessionId: session._id,
        frameType: String(message.type || "unknown").slice(0, 80),
      });
    };

    handshakeTimer = schedule(() => {
      if (setupReceived) return;
      releasePending();
      logOperationalWarning("conversation_relay.setup_timeout", {
        remoteAddress: connectionIp || remoteAddress(request),
      });
      closeTransport(1008, "ConversationRelay setup timeout.");
    }, handshakeTimeoutMs);

    socket.on("message", (raw) => {
      // Observe barge-in before queued dependency work settles. Keep frame
      // processing serialized, but immediately fence obsolete turn side effects.
      if (setupReceived && session && Buffer.byteLength(raw) <= MAX_FRAME_BYTES) {
        try {
          const frame = JSON.parse(raw.toString("utf8"));
          if (frame && typeof frame === "object" && (
            frame.type === "interrupt" ||
            (frame.type === "prompt" && String(frame.voicePrompt || "").trim()) ||
            (frame.type === "dtmf" && /^[0-9*#]$/.test(String(frame.digit || "")))
          )) {
            callerInputRevision += 1;
            clearIdleTimers();
            invalidateActiveTurn();
          }
        } catch {
          // The normal frame handler records malformed input.
        }
      }
      messageChain = messageChain
        .then(() => handleRelayMessage(raw))
        .catch(async (error) => {
          if (error?.code === "VOICE_TRANSPORT_CLOSED_DURING_SETUP") {
            // Idempotent safety cleanup. The close handler will perform
            // abandonment/outcome recovery after this setup chain settles.
            await releaseCapacity();
            await reconcileVoiceUsageSafely();
            return;
          }

          if (error?.code === "VOICE_FRAME_BEFORE_SETUP") {
            await failGracefully(error);
            return;
          }

          await failGracefully(error);
        })
        .catch((error) => {
          logOperationalError(
            "conversation_relay.failure_handler_rejected",
            error,
            { voiceSessionId: session?._id },
          );
          closeTransport();
        });
    });

    socket.on("close", (code, reasonBuffer) => {

      // Set this before any asynchronous cleanup so an in-flight setup can
      // never acquire or retain resources for an already-dead transport.
      transportClosed = true;

      releasePending();

      clearAllTimers();

      clearTimer(usageTopUpTimer);

      const closeReason = reasonBuffer?.toString?.().slice(0, 500) || "";

      // Serialize close recovery behind any in-flight final caller turn.

      // This prevents a booking or callback commit from racing abandonment.

      messageChain = messageChain

        .then(async () => {

          // A closed WebSocket is no longer consuming live-call capacity.
          // Free that inexpensive lease before heavier billing reconciliation.
          await releaseCapacity();

          await reconcileVoiceUsageSafely();

          if (!session?._id || intentionalEnd || failureStarted) return;

          const inferred = voiceOutcomeService.inferVoiceOutcome(session);

          if (inferred) {

            await voiceOutcomeService.commitVoiceOutcome({

              sessionId: session._id,

              outcome: inferred,

              status: "completed",

              metadata: { closeCode: code, closeReason },

            });

            return;

          }

          await voiceOutcomeService.recoverAbandonedVoiceCall({

            sessionId: session._id,

            closeCode: code,

            closeReason,

          });

        })

        .catch((error) =>

          logOperationalError(

            "conversation_relay.close_outcome_failed",

            error,

            { voiceSessionId: session?._id, closeCode: code },

          ),

        );

      cleanupTasks.add(messageChain);
      void messageChain.finally(() => cleanupTasks.delete(messageChain));
    });

    socket.on("error", (error) => {
      void failGracefully(error).catch((handlerError) => {
        logOperationalError(
          "conversation_relay.socket_error_handler_rejected",
          handlerError,
          { voiceSessionId: session?._id },
        );
        closeTransport();
      });
    });
  });

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
