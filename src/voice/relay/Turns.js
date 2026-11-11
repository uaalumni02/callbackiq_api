import { createTurnTimeoutError, isTransientDependencyError, logOperationalError, logOperationalWarning, runWithVoiceTurnContext, safeSend, sanitizeUnverifiedStaffCommitments, schedule } from './context.js';

export function createRelayTurns({ state, runtime, socket, request, connectionMeta, admissionController, coordinateConversationTurn, hardTurnTimeoutMs, softTurnTimeoutMs, voiceAgentService, voiceMetricsService, voiceOutcomeService, voiceSessionService }) {
const invalidateActiveTurn = () => {
      if (!state.activeTurnController || state.activeTurnController.signal.aborted) return;
      state.currentTurn += 1;
      const error = new Error("Caller input superseded the active voice turn.");
      error.code = "VOICE_STALE_TURN";
      state.activeTurnController.abort(error);
    };

const runAgentTurn = async (customerMessage) => {
      const turnStartedAt = Date.now();
      let settled = false;
      const turnId = ++state.currentTurn;
      const abortController = new AbortController();
      state.activeTurnController = abortController;
      const softTimer = schedule(() => {
        if (!settled && turnId === state.currentTurn) void runtime.sendAssistantText("One moment.", { preemptible: true });
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
            sessionId: String(state.session?._id || ""),
            turnId,
            signal: abortController.signal,
            isActive: () => !state.intentionalEnd && !state.failureStarted && turnId === state.currentTurn,
          },
          () => coordinateConversationTurn({ session: state.session, customerMessage, turnId,
            operation: () => voiceAgentService.handlePrompt({ session: state.session, customerMessage, signal: abortController.signal, turnId }) }),
        ), { signal: abortController.signal });
        const result = await Promise.race([agentPromise, timeoutPromise, cancellationPromise]);
        settled = true;
        if (turnId !== state.currentTurn || abortController.signal.aborted) {
          const error = new Error("A newer voice turn superseded this result.");
          error.code = "VOICE_STALE_TURN";
          throw error;
        }
        if (state.session?._id) void voiceMetricsService.recordVoiceMetric({ sessionId: state.session._id, event: "full_turn_latency_ms", value: Date.now() - turnStartedAt });
        return { result: result || {}, turnId };
      } finally {
        settled = true;
        runtime.clearTimer(softTimer);
        runtime.clearTimer(hardTimer);
        abortController.signal.removeEventListener("abort", abortListener);
      }
    };

const processAgentInput = async (customerMessage, { source = "speech" } = {}) => {
      const text = String(customerMessage || "").trim().slice(0, 4000);
      if (!text || !state.session || state.intentionalEnd || state.failureStarted) return;
      // A finalized caller turn proves the caller is present. Do not let
      // no-input timers run while dependencies process the request.
      runtime.clearIdleTimers();
      const inputRevision = state.callerInputRevision;
      const inputFinalizedAt = Date.now();
      state.session.metadata = { ...(state.session.metadata || {}), lastInputAtMs: inputFinalizedAt };
      await runtime.appendTranscriptSafely({ role: "customer", text });
      if (source !== "dtmf" && source !== "dtmf_zero") {
        const acknowledgment = /\b(?:hola|necesito|ayuda|por favor|español|espanol)\b/i.test(text)
          ? "Entiendo."
          : "Got it.";
        await runtime.sendAssistantText(acknowledgment, { preemptible: true, record: false });
        void voiceMetricsService.recordVoiceMetric({
          sessionId: state.session._id,
          event: "time_to_first_audio_ms",
          value: Date.now() - inputFinalizedAt,
        });
      }
      try {
        await voiceSessionService.touchActivity?.(state.session._id, {
          lastInputSource: source,
          lastInputAt: new Date().toISOString(),
        });
      } catch (error) {
        logOperationalWarning("conversation_relay.activity_touch_failed", {
          voiceSessionId: state.session._id,
          errorCode: error?.code || error?.name || "error",
        });
      }

      if (inputRevision !== state.callerInputRevision) return;
      let completedTurn;
      try {
        completedTurn = await runtime.runAgentTurn(text);
      } catch (caughtError) {
        let error = caughtError;
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
            completedTurn = await runtime.runAgentTurn(text);
          } catch (retryError) {
            error = retryError;
          }
        }
        if (error?.code === "VOICE_STALE_TURN") return;
        if (!completedTurn) {
          if (error?.code === "VOICE_ADMISSION_FULL") { await runtime.failGracefully(error); return; }
          state.consecutiveTurnFailures += 1;
          logOperationalError("conversation_relay.turn_failed", error, {
            businessId: state.session.business?._id || state.session.business,
            voiceSessionId: state.session._id,
            consecutiveTurnFailures: state.consecutiveTurnFailures,
            errorCode: error?.code || error?.name || "error",
          });
          if (state.consecutiveTurnFailures >= 3) {
            await runtime.failGracefully(error);
            return;
          }
          const timeout = error?.code === "VOICE_TURN_TIMEOUT";
          const recoveryReply =
            timeout
              ? "I’m sorry, that check took too long. Please say the request again, or say callback and I’ll preserve it for the team."
              : "I’m sorry, I could not complete that step. Please try once more, or say callback for team follow-up.";
          await runtime.sendAssistantText(recoveryReply, { preemptible: true });
          runtime.armIdleTimersAfterReply(recoveryReply);
          return;
        }
      }

      if (completedTurn.turnId !== state.currentTurn || state.intentionalEnd || state.failureStarted || state.transportClosed) return;
      const result = completedTurn.result;
      state.consecutiveTurnFailures = 0;
      const reply = sanitizeUnverifiedStaffCommitments(result?.reply, {
        channel: "voice",
      });
      if (reply) await runtime.sendAssistantText(reply);
      if (completedTurn.turnId !== state.currentTurn || state.intentionalEnd || state.failureStarted || state.transportClosed) return;
      if (result?.outcome) {
        await voiceOutcomeService.commitVoiceOutcome({ sessionId: state.session._id, outcome: result.outcome, metadata: { source: "voice_agent_result" } });
      }
      if (completedTurn.turnId !== state.currentTurn || state.intentionalEnd || state.failureStarted || state.transportClosed) return;
      if (!result?.handoff) runtime.armIdleTimersAfterReply(reply);
      if (result?.handoff) {
        state.intentionalEnd = true;
        runtime.clearIdleTimers();
        runtime.clearTimer(state.durationTimer);
        runtime.clearTimer(state.durationWarningTimer);
      runtime.clearTimer(state.usageTopUpTimer);
        await runtime.reconcileVoiceUsageSafely();
        await runtime.releaseCapacity();
        state.endTimer = schedule(() => {
          const sent = safeSend(socket, result.handoff);
          if (!sent) runtime.closeTransport(1011, "Handoff could not be delivered.");
        }, 700);
      }
    };
return { invalidateActiveTurn, runAgentTurn, processAgentInput };
}
