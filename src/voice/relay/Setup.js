import { WebSocket, safeSend, schedule } from './context.js';

export function createRelaySetup({ state, runtime, socket, request, connectionMeta, forceFailureAfterSetup, voiceCapacityService, voiceFraudDetectionService, voiceSessionService, voiceUsageService }) {
const handleSetup = async (message) => {
      const voiceSessionId = message.customParameters?.voiceSessionId;
      if (!voiceSessionId) {
        throw new Error("ConversationRelay setup omitted voiceSessionId.");
      }
      if (state.setupReceived) {
        if (String(state.session?._id || "") !== String(voiceSessionId)) {
          const error = new Error("A second setup frame changed the voice session.");
          error.code = "VOICE_DUPLICATE_SETUP_MISMATCH";
          throw error;
        }
        return;
      }

      state.session = await voiceSessionService.activateFromSetup({
        voiceSessionId,
        setup: message,
      });

      // The peer may disconnect while MongoDB is resolving the session.
      // Never continue provisioning a call whose transport is already gone.
      runtime.assertSetupTransportOpen();

      state.setupReceived = true;
      connectionMeta.localLease?.activate();

      /*
       * Wait until the distributed pending-IP admission lease is actually
       * removed before continuing into full-call capacity/usage reservation.
       * Without awaiting this write, rapid connection churn can see stale
       * pending leases and incorrectly return HTTP 429.
       */
      await runtime.releasePending();

      // The distributed lease release itself is asynchronous MongoDB work.
      runtime.assertSetupTransportOpen();

      runtime.clearTimer(state.handshakeTimer);
      state.handshakeTimer = null;

      if (!state.session.metadata?.preflightPassedAt) {
        const velocity =
          await voiceFraudDetectionService.evaluateCallerVelocity({
            businessId:
              state.session.business?._id || state.session.business,
            callerPhone: state.session.from,
            providerCallSid: state.session.providerCallSid,
            sessionId: state.session._id,
            maxCalls:
              state.session.business?.voiceSettings
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

      runtime.assertSetupTransportOpen();

      const capacity = await voiceCapacityService.acquireVoiceCapacity({
        business: state.session.business,
        session: state.session,
        settings: state.session.business?.voiceSettings || {},
      });
      if (capacity.allowed) {
        state.capacityReserved = true;
      }

      if (state.transportClosed || socket.readyState !== WebSocket.OPEN) {
        await runtime.releaseCapacity();
        runtime.assertSetupTransportOpen();
      }

      if (!capacity.allowed) {
        const error = new Error(
          "Voice AI capacity is temporarily unavailable. The configured recovery workflow was used.",
        );
        error.code = capacity.reason || "VOICE_CONCURRENCY_LIMIT";
        throw error;
      }

      const usage = await voiceUsageService.reserveVoiceUsage({
        business: state.session.business,
        sessionId: state.session._id,
        reserveSeconds: 60,
        reservationKey: `voice:${state.session._id}:initial`,
      });

      if (usage.allowed) {
        state.voiceUsageReservedSeconds = Number(usage.reservedSeconds) || 0;
      }

      if (state.transportClosed || socket.readyState !== WebSocket.OPEN) {
        // The call disappeared while usage reservation was being persisted.
        // Undo both resources before leaving setup.
        await runtime.releaseCapacity();
        await runtime.reconcileVoiceUsageSafely();
        runtime.assertSetupTransportOpen();
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
        if (!state.session?._id || state.intentionalEnd || state.failureStarted || state.voiceUsageReconciled) return;
        const extra = await voiceUsageService.reserveVoiceUsage({business: state.session.business, sessionId: state.session._id, reserveSeconds: 60, reservationKey: `voice:${state.session._id}:topup:${++voiceUsageTopUpSequence}`});
        if (!extra.allowed) {
          const error = new Error("The voice allowance was reached during the call. The request will be preserved as a callback.");
          error.code = extra.reason || "VOICE_ALLOWANCE_EXHAUSTED_MID_CALL";
          await runtime.failGracefully(error);
          return;
        }
        state.voiceUsageReservedSeconds += Number(extra.reservedSeconds) || 0;
        state.usageTopUpTimer = schedule(() => void topUp(), topUpEveryMs);
      };
      state.usageTopUpTimer = schedule(() => void topUp(), topUpEveryMs);

      runtime.scheduleDurationLimit();
      const configuredGreeting = String(
        state.session.business?.voiceSettings?.welcomeGreeting || "",
      ).trim();
      const defaultGreeting = state.session.business?.businessName
        ? `Thanks for calling ${state.session.business.businessName}. How can I help you today?`
        : "Thanks for calling. How can I help you today?";
      runtime.armIdleTimersAfterReply(configuredGreeting || defaultGreeting);
      await runtime.appendTranscriptSafely({
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
          voiceSessionId: String(state.session._id),
        });
      }
      if (forceFailureAfterSetup) {
        throw new Error("Forced Phase 9 staging WebSocket failure test.");
      }
    };
return { handleSetup };
}
