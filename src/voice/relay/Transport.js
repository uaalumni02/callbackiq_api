import { VOICE_ROUTE, WebSocket, determineVoiceFailureRoute, logOperationalError, normalizeVoiceSettings, safeSend, schedule } from './context.js';

export function createRelayTransport({ state, runtime, socket, request, connectionMeta, failureCloseDelayMs, failureEndDelayMs, voiceFailureService, voiceSessionService }) {
const assertSetupTransportOpen = () => {
      if (!state.transportClosed && socket.readyState === WebSocket.OPEN) return;

      const error = new Error(
        "ConversationRelay transport closed while voice setup was still in progress.",
      );
      error.code = "VOICE_TRANSPORT_CLOSED_DURING_SETUP";
      throw error;
    };

const closeTransport = (code = 1011, reason = "Voice session ended.") => {
      if (socket.readyState === WebSocket.CLOSED) return;
      try {
        socket.close(code, String(reason).slice(0, 120));
      } catch (error) {
        logOperationalError("conversation_relay.close_failed", error, {
          voiceSessionId: state.session?._id,
        });
        socket.terminate();
      }
    };

const persistFallbackSafely = async (reason) => {
      if (!state.session?._id) return;
      try {
        const settings = normalizeVoiceSettings(state.session.business);
        if (
          determineVoiceFailureRoute({ settings }) === VOICE_ROUTE.DIAL_STAFF
        ) {
          await voiceFailureService.record({
            sessionId: state.session._id,
            failureReason: reason,
          });
          return;
        }
        await voiceSessionService.sendFallbackSms({
          sessionId: state.session._id,
          failureReason: reason,
        });
      } catch (error) {
        logOperationalError(
          "conversation_relay.fallback_persistence_failed",
          error,
          {
            businessId: state.session?.business?._id || state.session?.business,
            voiceSessionId: state.session?._id,
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
          voiceSessionId: state.session?._id ? String(state.session._id) : "",
        }),
      });
      state.closeTimer = schedule(
        () => runtime.closeTransport(1000, "ConversationRelay handoff completed."),
        failureCloseDelayMs,
      );
      return sent;
    };

const failGracefully = async (error, { speak = true } = {}) => {
      if (state.failureStarted || state.intentionalEnd) return;
      state.failureStarted = true;
      state.intentionalEnd = true;
      runtime.clearIdleTimers();
      runtime.clearTimer(state.durationTimer);
      runtime.clearTimer(state.durationWarningTimer);
      runtime.clearTimer(state.usageTopUpTimer);
      const reason = String(error?.message || "ConversationRelay failure").slice(
        0,
        2000,
      );
      logOperationalError("conversation_relay.session_failure", error, {
        businessId: state.session?.business?._id || state.session?.business,
        voiceSessionId: state.session?._id,
        providerCallSid: state.session?.providerCallSid,
        errorCode: error?.code || error?.name || "error",
      });
      if (speak) {
        await runtime.sendAssistantText(
          "I’m sorry, I’m having trouble continuing this call. I cannot verify that your request reached the team. Please contact the business directly. No appointment is confirmed by this call.",
          { interruptible: false, preemptible: true },
        );
      }
      state.endTimer = schedule(
        () => runtime.sendEndPacket("voice-failure", reason),
        failureEndDelayMs,
      );
      await runtime.reconcileVoiceUsageSafely();
      await runtime.releaseCapacity();
      await runtime.persistFallbackSafely(reason);
    };

const endForNoInput = async () => {
      if (!state.session?._id || state.intentionalEnd || state.failureStarted) return;
      state.intentionalEnd = true;
      runtime.clearIdleTimers();
      await runtime.sendAssistantText(
        "I’m not hearing a response, so I’m ending the call now. I’ll preserve the call record for the configured follow-up workflow.",
        { interruptible: false, preemptible: true },
      );
      await runtime.reconcileVoiceUsageSafely();
      await runtime.releaseCapacity();
      await runtime.persistFallbackSafely("Caller provided no input after two prompts.");
      state.endTimer = schedule(
        () => runtime.sendEndPacket("no-input", "Caller provided no input."),
        failureEndDelayMs,
      );
    };
return { assertSetupTransportOpen, closeTransport, persistFallbackSafely, sendEndPacket, failGracefully, endForNoInput };
}
