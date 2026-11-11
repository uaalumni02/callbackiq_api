import { DEFAULT_DURATION_WARNING_SECONDS, DEFAULT_MAX_CALL_DURATION_SECONDS, boundedInteger, getMaximumDurationSeconds, schedule } from './context.js';

export function createRelayTimers({ state, runtime, socket, request, connectionMeta, durationLimitMs, failureEndDelayMs, idleEndMs, idleFirstMs, idleSecondMs, voiceOutcomeService }) {
const clearTimer = (timer) => {
      if (timer) clearTimeout(timer);
    };

const clearIdleTimers = () => {
      runtime.clearTimer(state.idleArmTimer);
      state.idleArmTimer = null;
      for (const timer of state.idleTimers) runtime.clearTimer(timer);
      state.idleTimers = [];
    };

const clearAllTimers = () => {
      runtime.clearTimer(state.endTimer);
      runtime.clearTimer(state.closeTimer);
      runtime.clearTimer(state.handshakeTimer);
      runtime.clearTimer(state.durationTimer);
      runtime.clearTimer(state.durationWarningTimer);
      runtime.clearTimer(state.usageTopUpTimer);
      runtime.clearTimer(state.dtmfTimer);
      runtime.clearIdleTimers();
      state.endTimer = null;
      state.closeTimer = null;
      state.handshakeTimer = null;
      state.durationTimer = null;
      state.durationWarningTimer = null;
      state.dtmfTimer = null;
    };

const resetIdleTimers = () => {
      runtime.clearIdleTimers();
      if (!state.setupReceived || state.intentionalEnd || state.failureStarted) return;
      state.idleTimers = [
        schedule(() => {
          void runtime.sendAssistantText(
            "Are you still there? Take your time. I’m listening for your next question or service request.",
            { preemptible: true },
          );
        }, idleFirstMs),
        schedule(() => {
          void runtime.sendAssistantText(
            "I still haven’t heard anything. You can ask another question, describe the service you need, or say callback.",
            { preemptible: true },
          );
        }, idleSecondMs),
        schedule(() => {
          void runtime.endForNoInput();
        }, idleEndMs),
      ];
    };

const armIdleTimersAfterReply = (text) => {

      runtime.clearIdleTimers();

      if (!state.setupReceived || state.intentionalEnd || state.failureStarted) return;

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

      state.idleArmTimer = schedule(() => {

        state.idleArmTimer = null;

        runtime.resetIdleTimers();

      }, estimatedPlaybackMs);

    };

const scheduleDurationLimit = () => {
      if (state.durationTimer || !state.session?._id) return;
      const maximumDurationSeconds = getMaximumDurationSeconds(state.session);
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
        state.durationWarningTimer = schedule(() => {
          void runtime.sendAssistantText(
            `We have about ${warningSeconds} seconds left on this call. I can finish a booking step or capture a callback request.`,
            { preemptible: true },
          );
        }, maximumMs - warningSeconds * 1000);
      }
      state.durationTimer = schedule(() => {
        void (async () => {
          if (state.intentionalEnd || state.failureStarted) return;
          state.intentionalEnd = true;
          runtime.clearIdleTimers();
          await runtime.sendAssistantText(
            "We reached the call time limit. I’m saving the confirmed details for follow-up now.",
            { interruptible: false, preemptible: true },
          );
          const inferred = voiceOutcomeService.inferVoiceOutcome(state.session);
          await voiceOutcomeService.commitVoiceOutcome({
            sessionId: state.session._id,
            outcome: inferred || "duration_limit_callback_captured",
            status: "completed",
            metadata: { source: "duration_limit", maximumSeconds: Math.round(maximumMs / 1000) },
          });
          await runtime.reconcileVoiceUsageSafely();
          await runtime.releaseCapacity();
          state.endTimer = schedule(() => runtime.sendEndPacket("duration-limit", "Configured duration limit reached."), failureEndDelayMs);
        })().catch((error) => runtime.failGracefully(error));
      }, maximumMs);
    };
return { clearTimer, clearIdleTimers, clearAllTimers, resetIdleTimers, armIdleTimersAfterReply, scheduleDurationLimit };
}
