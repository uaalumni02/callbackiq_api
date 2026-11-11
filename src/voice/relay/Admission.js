import { logOperationalError } from './context.js';

export function createRelayAdmission({ state, runtime, socket, request, connectionMeta, voiceCapacityService, voiceConnectionLeaseService, voiceUsageService }) {
const releasePending = () => {
      /*
       * The pending-IP lease protects only the WebSocket admission/setup
       * window. Once setup succeeds, MongoDB must actually remove the lease
       * before this caller stops consuming a pending slot.
       *
       * Keep the operation idempotent and share the same promise across
       * setup, close, and timeout paths.
       */
      if (state.pendingIpReleasePromise) return state.pendingIpReleasePromise;

      state.pendingIpReleasePromise = Promise.resolve(
        voiceConnectionLeaseService.releaseVoiceConnectionLease(state.connectionLease),
      ).catch((error) => {
        logOperationalError(
          "conversation_relay.connection_lease_release_failed",
          error,
        );
      });

      return state.pendingIpReleasePromise;
    };

const releaseCapacity = async () => {
      if (!state.capacityReserved || !state.session?._id) return;
      state.capacityReserved = false;
      try {
        await voiceCapacityService.releaseVoiceCapacity({
          businessId: state.session.business?._id || state.session.business,
          session: state.session,
        });
      } catch (error) {
        logOperationalError("conversation_relay.capacity_release_failed", error, {
          businessId: state.session.business?._id || state.session.business,
          voiceSessionId: state.session._id,
        });
      }
    };

const reconcileVoiceUsageSafely = async () => {
      if (
        state.voiceUsageReconciled ||
        !state.session?._id ||
        !state.voiceUsageReservedSeconds
      ) {
        return;
      }

      state.voiceUsageReconciled = true;

      const startedAt = new Date(
        state.session.startedAt || Date.now(),
      ).getTime();

      const actualSeconds = Math.max(
        1,
        Math.ceil((Date.now() - startedAt) / 1000),
      );

      try {
        const payload = {
          businessId:
            state.session.business?._id || state.session.business,
          sessionId: state.session._id,
          actualSeconds,
          openAiInputTokens:
            Number(state.session.openAiUsage?.inputTokens) || 0,
          openAiOutputTokens:
            Number(state.session.openAiUsage?.outputTokens) || 0,
          transferAttempts:
            Number(state.session.metadata?.transferAttempts) || 0,
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
              state.session.business?._id || state.session.business,
            voiceSessionId: state.session._id,
          },
        );
      }
    };
return { releasePending, releaseCapacity, reconcileVoiceUsageSafely };
}
