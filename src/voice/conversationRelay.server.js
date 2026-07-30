import twilio from "twilio";
import { WebSocket, WebSocketServer } from "ws";

import VoiceAgentService from "./voiceAgent.service.js";
import VoiceSessionService from "./voiceSession.service.js";
import VoiceFailureService from "./voiceFailure.service.js";
import VoiceTranscriptService from "./voiceTranscript.service.js";
import {
  getVoiceWebSocketUrl,
  isPhase9ForcedRelayFailureEnabled,
  normalizeVoiceSettings,
} from "./voiceRouting.service.js";
import {
  determineVoiceFailureRoute,
  VOICE_ROUTE,
} from "./voiceRoutingPolicy.service.js";
import VoiceCapacityService from "../services/voiceCapacity.service.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";

const PATH = "/ws/voice";
const DEFAULT_END_DELAY_MS = 1200;
const DEFAULT_CLOSE_DELAY_MS = 4000;

const rejectUpgrade = (socket, statusCode, message) => {
  if (!socket.destroyed) {
    socket.write(
      `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`,
    );
    socket.destroy();
  }
};

export const validateConversationRelaySignature = (request) => {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.DISABLE_TWILIO_SIGNATURE_VALIDATION === "true"
  ) {
    return true;
  }
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = request.headers["x-twilio-signature"];
  const publicUrl = getVoiceWebSocketUrl();

  if (!authToken || !signature || !publicUrl) return false;

  return twilio.validateRequest(authToken, signature, publicUrl, {});
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

const schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, Math.max(0, Number(delayMs) || 0));
  timer.unref?.();
  return timer;
};

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const getMaximumDurationSeconds = (session) =>
  boundedInteger(
    session?.business?.voiceSettings?.maxCallDurationSeconds ??
      process.env.DEFAULT_VOICE_MAX_DURATION_SECONDS,
    3600,
    60,
    7200,
  );

/**
 * Attach Twilio ConversationRelay to an existing HTTP server.
 *
 * Optional dependencies remain injectable so the real transport can be tested
 * without changing its production orchestration.
 */
export const initializeConversationRelayServer = (
  httpServer,
  {
    voiceAgentService = VoiceAgentService,
    voiceSessionService = VoiceSessionService,
    voiceTranscriptService = VoiceTranscriptService,
    voiceFailureService = VoiceFailureService,
    voiceCapacityService = VoiceCapacityService,
    signatureValidator = validateConversationRelaySignature,
    failureEndDelayMs = DEFAULT_END_DELAY_MS,
    failureCloseDelayMs = DEFAULT_CLOSE_DELAY_MS,
    durationLimitMs = null,
    forceFailureAfterSetup = isPhase9ForcedRelayFailureEnabled(),
  } = {},
) => {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const upgradeHandler = (request, socket, head) => {
    let pathname;

    try {
      pathname = new URL(request.url, "http://localhost").pathname;
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

    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
  };

  httpServer.on("upgrade", upgradeHandler);

  wss.on("connection", (socket) => {
    let session = null;
    let messageChain = Promise.resolve();
    let intentionalEnd = false;
    let failureStarted = false;
    let capacityReserved = false;
    let endTimer = null;
    let closeTimer = null;
    let durationTimer = null;

    const clearTimers = () => {
      if (endTimer) clearTimeout(endTimer);
      if (closeTimer) clearTimeout(closeTimer);
      if (durationTimer) clearTimeout(durationTimer);
      endTimer = null;
      closeTimer = null;
      durationTimer = null;
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

    const closeTransport = () => {
      if (socket.readyState === WebSocket.CLOSED) return;

      try {
        socket.close(1011, "ConversationRelay session ended after failure.");
      } catch (error) {
        logOperationalError("conversation_relay.close_failed", error, {
          businessId: session?.business?._id || session?.business,
          voiceSessionId: session?._id,
        });
        socket.terminate();
      }
    };

    const scheduleFailureEnd = (reason) => {
      // Schedule the ConversationRelay end before database or SMS work. That
      // keeps the caller protected even when a secondary system rejects.
      endTimer = schedule(() => {
        safeSend(socket, {
          type: "end",
          handoffData: JSON.stringify({
            reasonCode: "voice-failure",
            reason,
            voiceSessionId: session?._id ? String(session._id) : "",
          }),
        });
        closeTimer = schedule(closeTransport, failureCloseDelayMs);
      }, failureEndDelayMs);
    };

    const persistFallbackSafely = async (reason) => {
      if (!session?._id) return;

      try {
        const settings = normalizeVoiceSettings(session.business);
        // The HTTP ConversationRelay callback performs a configured staff-first
        // route. Do not send SMS here before that transfer attempt.
        if (
          determineVoiceFailureRoute({ settings }) ===
          VOICE_ROUTE.DIAL_STAFF
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
      } catch (fallbackError) {
        logOperationalError(
          "conversation_relay.fallback_persistence_failed",
          fallbackError,
          {
            businessId: session?.business?._id || session?.business,
            voiceSessionId: session?._id,
          },
        );
      }
    };

    const failGracefully = async (error) => {
      if (failureStarted || intentionalEnd) return;

      failureStarted = true;
      intentionalEnd = true;

      const reason = error?.message || "ConversationRelay failure";
      logOperationalError("conversation_relay.session_failure", error, {
        businessId: session?.business?._id || session?.business,
        voiceSessionId: session?._id,
        providerCallSid: session?.providerCallSid,
      });
      safeSend(socket, {
        type: "text",
        token:
          "I’m sorry, I’m having trouble continuing this call. I’ll connect you with the team or send a text so they can follow up.",
        last: true,
        interruptible: false,
      });

      scheduleFailureEnd(reason);
      await releaseCapacity();
      await persistFallbackSafely(reason);
    };

    const scheduleDurationLimit = () => {
      if (durationTimer || !session?._id) return;
      const maximumDurationSeconds = getMaximumDurationSeconds(session);
      const delayMs =
        durationLimitMs == null
          ? maximumDurationSeconds * 1000
          : boundedInteger(durationLimitMs, maximumDurationSeconds * 1000, 1, 7_200_000);
      durationTimer = schedule(() => {
        const error = new Error(
          `Voice AI session reached the ${maximumDurationSeconds}-second duration limit.`,
        );
        error.code = "VOICE_DURATION_LIMIT";
        void failGracefully(error);
      }, delayMs);
    };

    socket.on("message", (raw) => {
      messageChain = messageChain
        .then(async () => {
          const message = JSON.parse(raw.toString("utf8"));
          if (message.type === "setup") {
            const voiceSessionId = message.customParameters?.voiceSessionId;
            if (!voiceSessionId) {
              throw new Error(
                "ConversationRelay setup omitted voiceSessionId.",
              );
            }

            session = await voiceSessionService.activateFromSetup({
              voiceSessionId,
              setup: message,
            });

            const capacity = await voiceCapacityService.acquireVoiceCapacity({
              business: session.business,
              session,
              settings: session.business?.voiceSettings || {},
            });
            if (!capacity.allowed) {
              const error = new Error(
                "Voice AI capacity is temporarily unavailable. The normal fallback workflow was used.",
              );
              error.code = capacity.reason || "VOICE_CONCURRENCY_LIMIT";
              throw error;
            }
            capacityReserved = true;
            scheduleDurationLimit();

            await voiceTranscriptService.append({
              sessionId: session._id,
              role: "system",
              text: "ConversationRelay session connected.",
            });

            if (forceFailureAfterSetup) {
              throw new Error(
                "Forced Phase 9 staging WebSocket failure test.",
              );
            }
            return;
          }
          if (message.type === "prompt" && message.last === true) {
            if (!session) throw new Error("Prompt received before setup.");

            const customerMessage = String(message.voicePrompt || "").trim();
            if (!customerMessage) return;

            await voiceTranscriptService.append({
              sessionId: session._id,
              role: "customer",
              text: customerMessage,
            });
            session = await voiceSessionService.activateFromSetup({
              voiceSessionId: session._id,
              setup: {
                callSid: session.providerCallSid,
                sessionId: session.providerSessionId,
                from: session.from,
                to: session.to,
                customParameters: {
                  businessId: String(session.business._id),
                },
              },
            });
            const result = await voiceAgentService.handlePrompt({
              session,
              customerMessage,
            });
            const reply = String(result.reply || "").trim();

            if (reply) {
              await voiceTranscriptService.append({
                sessionId: session._id,
                role: "assistant",
                text: reply,
              });
              safeSend(socket, {
                type: "text",
                token: reply,
                last: true,
                interruptible: true,
              });
            }

            if (result.handoff) {
              intentionalEnd = true;
              if (durationTimer) clearTimeout(durationTimer);
              durationTimer = null;
              await releaseCapacity();
              schedule(() => safeSend(socket, result.handoff), 900);
            }
            return;
          }
          if (message.type === "error") {
            throw new Error(
              message.description || "ConversationRelay error",
            );
          }
        })
        .catch(failGracefully)
        .catch((error) => {
          // Keep the event chain contained if a future change accidentally
          // introduces a rejection in failGracefully.
          logOperationalError(
            "conversation_relay.failure_handler_rejected",
            error,
            {
              businessId: session?.business?._id || session?.business,
              voiceSessionId: session?._id,
            },
          );
        });
    });

    socket.on("close", (code, reason) => {
      clearTimers();

      messageChain = messageChain
        .then(async () => {
          await releaseCapacity();
          if (!session?._id) return;
          if (intentionalEnd || session.status === "transferring") return;
          if (code === 1000) {
            try {
              await voiceSessionService.markCompleted(session._id, {
                closeCode: code,
                closeReason: reason.toString(),
              });
            } catch (error) {
              logOperationalError(
                "conversation_relay.completion_persistence_failed",
                error,
                {
                  businessId: session?.business?._id || session?.business,
                  voiceSessionId: session?._id,
                  closeCode: code,
                },
              );
            }
            return;
          }
          await persistFallbackSafely(
            `ConversationRelay WebSocket closed with code ${code}: ${reason.toString()}`,
          );
        })
        .catch((error) => {
          logOperationalError("conversation_relay.close_handler_failed", error, {
            businessId: session?.business?._id || session?.business,
            voiceSessionId: session?._id,
            closeCode: code,
          });
        });
    });

    socket.on("error", (error) => {
      void failGracefully(error).catch((handlerError) => {
        logOperationalError(
          "conversation_relay.socket_error_handler_rejected",
          handlerError,
          {
            businessId: session?.business?._id || session?.business,
            voiceSessionId: session?._id,
          },
        );
        closeTransport();
      });
    });
  });

  return {
    async close() {
      httpServer.off("upgrade", upgradeHandler);
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  };
};

export default initializeConversationRelayServer;
