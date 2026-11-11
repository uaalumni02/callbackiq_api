import { createRelayTranscript } from './Transcript.js';
import { createRelayAdmission } from './Admission.js';
import { createRelayTransport } from './Transport.js';
import { createRelayTimers } from './Timers.js';
import { createRelayTurns } from './Turns.js';
import { createRelayInput } from './Input.js';
import { createRelaySetup } from './Setup.js';
import { MAX_FRAME_BYTES, logOperationalError, logOperationalWarning, remoteAddress, resolveTrustedRemoteAddress, schedule } from "./context.js";

export function createRelayConnectionHandler(options) {
  return async (socket, request, connectionMeta = {}) => {
    const state = {};
    const runtime = {};
    const dependencies = { ...options, state, runtime, socket, request, connectionMeta };
    const { cleanupTasks, handshakeTimeoutMs, voiceOutcomeService } = options;
state.connectionIp = connectionMeta.ip || resolveTrustedRemoteAddress(request);
state.connectionLease = connectionMeta.lease || null;
state.session = null;
state.setupReceived = false;
state.pendingIpReleasePromise = null;
state.transportClosed = false;
state.intentionalEnd = false;
state.failureStarted = false;
state.capacityReserved = false;
state.voiceUsageReservedSeconds = 0;
state.voiceUsageReconciled = false;
state.usageTopUpTimer = null;
state.messageChain = Promise.resolve();
state.endTimer = null;
state.closeTimer = null;
state.handshakeTimer = null;
state.durationTimer = null;
state.durationWarningTimer = null;
state.idleTimers = [];
state.idleArmTimer = null;
state.dtmfTimer = null;
state.dtmfBuffer = "";
state.consecutiveTurnFailures = 0;
state.currentTurn = 0;
state.activeTurnController = null;
state.callerInputRevision = 0;

  Object.assign(runtime, createRelayTranscript(dependencies));
  Object.assign(runtime, createRelayAdmission(dependencies));
  Object.assign(runtime, createRelayTransport(dependencies));
  Object.assign(runtime, createRelayTimers(dependencies));
  Object.assign(runtime, createRelayTurns(dependencies));
  Object.assign(runtime, createRelayInput(dependencies));
  Object.assign(runtime, createRelaySetup(dependencies));
state.handshakeTimer = schedule(() => {
      if (state.setupReceived) return;
      runtime.releasePending();
      logOperationalWarning("conversation_relay.setup_timeout", {
        remoteAddress: state.connectionIp || remoteAddress(request),
      });
      runtime.closeTransport(1008, "ConversationRelay setup timeout.");
    }, handshakeTimeoutMs);
socket.on("message", (raw) => {
      // Observe barge-in before queued dependency work settles. Keep frame
      // processing serialized, but immediately fence obsolete turn side effects.
      if (state.setupReceived && state.session && Buffer.byteLength(raw) <= MAX_FRAME_BYTES) {
        try {
          const frame = JSON.parse(raw.toString("utf8"));
          if (frame && typeof frame === "object" && (
            frame.type === "interrupt" ||
            (frame.type === "prompt" && String(frame.voicePrompt || "").trim()) ||
            (frame.type === "dtmf" && /^[0-9*#]$/.test(String(frame.digit || "")))
          )) {
            state.callerInputRevision += 1;
            runtime.clearIdleTimers();
            runtime.invalidateActiveTurn();
          }
        } catch {
          // The normal frame handler records malformed input.
        }
      }
      state.messageChain = state.messageChain
        .then(() => runtime.handleRelayMessage(raw))
        .catch(async (error) => {
          if (error?.code === "VOICE_TRANSPORT_CLOSED_DURING_SETUP") {
            // Idempotent safety cleanup. The close handler will perform
            // abandonment/outcome recovery after this setup chain settles.
            await runtime.releaseCapacity();
            await runtime.reconcileVoiceUsageSafely();
            return;
          }

          if (error?.code === "VOICE_FRAME_BEFORE_SETUP") {
            await runtime.failGracefully(error);
            return;
          }

          await runtime.failGracefully(error);
        })
        .catch((error) => {
          logOperationalError(
            "conversation_relay.failure_handler_rejected",
            error,
            { voiceSessionId: state.session?._id },
          );
          runtime.closeTransport();
        });
    });
socket.on("close", (code, reasonBuffer) => {

      // Set this before any asynchronous cleanup so an in-flight setup can
      // never acquire or retain resources for an already-dead transport.
      state.transportClosed = true;

      runtime.releasePending();

      runtime.clearAllTimers();

      runtime.clearTimer(state.usageTopUpTimer);

      const closeReason = reasonBuffer?.toString?.().slice(0, 500) || "";

      // Serialize close recovery behind any in-flight final caller turn.

      // This prevents a booking or callback commit from racing abandonment.

      state.messageChain = state.messageChain

        .then(async () => {

          // A closed WebSocket is no longer consuming live-call capacity.
          // Free that inexpensive lease before heavier billing reconciliation.
          await runtime.releaseCapacity();

          await runtime.reconcileVoiceUsageSafely();

          if (!state.session?._id || state.intentionalEnd || state.failureStarted) return;

          const inferred = voiceOutcomeService.inferVoiceOutcome(state.session);

          if (inferred) {

            await voiceOutcomeService.commitVoiceOutcome({

              sessionId: state.session._id,

              outcome: inferred,

              status: "completed",

              metadata: { closeCode: code, closeReason },

            });

            return;

          }

          await voiceOutcomeService.recoverAbandonedVoiceCall({

            sessionId: state.session._id,

            closeCode: code,

            closeReason,

          });

        })

        .catch((error) =>

          logOperationalError(

            "conversation_relay.close_outcome_failed",

            error,

            { voiceSessionId: state.session?._id, closeCode: code },

          ),

        );

      cleanupTasks.add(state.messageChain);
      void state.messageChain.finally(() => cleanupTasks.delete(state.messageChain));
    });
socket.on("error", (error) => {
      void runtime.failGracefully(error).catch((handlerError) => {
        logOperationalError(
          "conversation_relay.socket_error_handler_rejected",
          handlerError,
          { voiceSessionId: state.session?._id },
        );
        runtime.closeTransport();
      });
    });
  };
}
