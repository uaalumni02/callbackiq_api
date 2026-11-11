import { MAX_FRAME_BYTES, RECOVERABLE_RELAY_ERROR_CODES, boundedInteger, extractRelayErrorCode, logOperationalError, logOperationalWarning, safeSend, sanitizeDtmfDigits, schedule } from './context.js';

export function createRelayInput({ state, runtime, socket, request, connectionMeta, voiceOutcomeService, voiceTranscriptService }) {
const flushDtmf = async () => {
      runtime.clearTimer(state.dtmfTimer);
      state.dtmfTimer = null;
      const digits = sanitizeDtmfDigits(state.dtmfBuffer);
      state.dtmfBuffer = "";
      if (!digits) return;
      await runtime.processAgentInput(digits, { source: "dtmf" });
    };

const handleDtmf = async (digitValue) => {
      const digit = String(digitValue || "").slice(0, 1);
      if (!/^[0-9#*]$/.test(digit)) return;
      runtime.clearIdleTimers();
      if (digit === "0" && !state.dtmfBuffer) {
        await runtime.processAgentInput("I want to speak to a person.", {
          source: "dtmf_zero",
        });
        return;
      }
      if (digit === "*") {
        state.dtmfBuffer = "";
        runtime.clearTimer(state.dtmfTimer);
        state.dtmfTimer = null;
        const digitResetReply =
          "I cleared the entered digits. Please enter them again.";
        await runtime.sendAssistantText(digitResetReply);
        runtime.armIdleTimersAfterReply(digitResetReply);
        return;
      }
      if (digit === "#") {
        await runtime.flushDtmf();
        return;
      }
      state.dtmfBuffer = `${state.dtmfBuffer}${digit}`.slice(0, 20);
      runtime.clearTimer(state.dtmfTimer);
      state.dtmfTimer = schedule(() => {
        state.messageChain = state.messageChain.then(runtime.flushDtmf).catch((error) => {
          logOperationalError("conversation_relay.dtmf_flush_failed", error, {
            voiceSessionId: state.session?._id,
          });
        });
      }, 1300);
    };

const handleRelayMessage = async (raw) => {
      if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) {
        logOperationalWarning("conversation_relay.frame_too_large", {
          voiceSessionId: state.session?._id,
        });
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch (error) {
        logOperationalWarning("conversation_relay.malformed_frame", {
          voiceSessionId: state.session?._id,
          errorCode: error?.name || "syntax_error",
        });
        return;
      }
      if (!message || typeof message !== "object") return;

      if (message.type === "setup") {
        await runtime.handleSetup(message);
        return;
      }
      if (!state.setupReceived || !state.session) {
        const error = new Error(`${message.type || "Unknown"} frame arrived before setup.`);
        error.code = "VOICE_FRAME_BEFORE_SETUP";
        throw error;
      }

      if (message.type === "prompt") {
        // A partial prompt is proof that the caller is speaking. Clear the
        // no-input timers immediately; process only the finalized transcript.
        runtime.clearIdleTimers();
        if (message.last !== true) return;
        const text = String(message.voicePrompt || "").trim();
        if (text) await runtime.processAgentInput(text, { source: "speech" });
        return;
      }
      if (message.type === "dtmf") {
        await runtime.handleDtmf(message.digit);
        return;
      }
      if (message.type === "interrupt") {
        // The caller is actively speaking. Re-arm only after the finalized
        // prompt has been processed and answered.
        runtime.clearIdleTimers();
        try {
          await voiceTranscriptService.markLastAssistantInterrupted?.(state.session._id);
          await voiceTranscriptService.touch?.(state.session._id, {
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
            voiceSessionId: state.session._id,
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
        if (!state.session?._id || !state.setupReceived) return;

        runtime.clearAllTimers();
        runtime.clearTimer(state.usageTopUpTimer);

        const requestedOutcome =
          message.outcome === "caller_declined"
            ? "caller_declined"
            : "direct_answer_resolved";

        const inferred =
          voiceOutcomeService.inferVoiceOutcome(state.session);

        await voiceOutcomeService.commitVoiceOutcome({
          sessionId: state.session._id,
          outcome: inferred || requestedOutcome,
          status: "completed",
          metadata: {
            source: "synthetic_load_test",
            synthetic: true,
          },
        });

        state.intentionalEnd = true;

        // The transport no longer needs a live concurrency slot.
        await runtime.releaseCapacity();

        // Reconciliation only queues durable accounting work now.
        await runtime.reconcileVoiceUsageSafely();

        safeSend(socket, {
          type: "callbackiq_test_complete_ack",
          voiceSessionId: String(state.session._id),
        });

        runtime.closeTransport(
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
            voiceSessionId: state.session._id,
            errorCode,
          });
          return;
        }
        throw error;
      }

      logOperationalWarning("conversation_relay.unknown_frame", {
        voiceSessionId: state.session._id,
        frameType: String(message.type || "unknown").slice(0, 80),
      });
    };
return { flushDtmf, handleDtmf, handleRelayMessage };
}
