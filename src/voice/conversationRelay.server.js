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
    console.error("ConversationRelay WebSocket send failed:", error);
    return false;
  }
};

const schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, Math.max(0, Number(delayMs) || 0));
  timer.unref?.();
  return timer;
};

/**
 * Attach Twilio ConversationRelay to an existing HTTP server.
 *
 * The optional dependencies are intentionally injectable so the transport can
 * be exercised as a real HTTP/WebSocket integration in the completion suite
 * without replacing the ConversationRelay orchestration itself.
 */
export const initializeConversationRelayServer = (
  httpServer,
  {
    voiceAgentService = VoiceAgentService,
    voiceSessionService = VoiceSessionService,
    voiceTranscriptService = VoiceTranscriptService,
    voiceFailureService = VoiceFailureService,
    signatureValidator = validateConversationRelaySignature,
    failureEndDelayMs = DEFAULT_END_DELAY_MS,
    failureCloseDelayMs = DEFAULT_CLOSE_DELAY_MS,
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
      console.error("ConversationRelay signature validation failed:", error);
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
    let endTimer = null;
    let closeTimer = null;

    const clearTimers = () => {
      if (endTimer) clearTimeout(endTimer);
      if (closeTimer) clearTimeout(closeTimer);
      endTimer = null;
      closeTimer = null;
    };

    const closeTransport = () => {
      if (socket.readyState === WebSocket.CLOSED) return;

      try {
        socket.close(1011, "ConversationRelay session ended after failure.");
      } catch (error) {
        console.error("ConversationRelay close failed:", error);
        socket.terminate();
      }
    };

    const scheduleFailureEnd = (reason) => {
      // Schedule the ConversationRelay end before any database or SMS work.
      // That guarantees the caller is not stranded if those secondary systems
      // reject or never resolve.
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

        // The HTTP ConversationRelay action callback performs the configured
        // staff-first failure path. Sending SMS here would violate that choice
        // by texting before the transfer attempt. SMS-only failure policies are
        // handled here as an additional idempotent safety net.
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
        // This is a secondary failure. The call termination is already
        // scheduled and must never depend on this operation succeeding.
        console.error(
          "ConversationRelay fallback SMS/persistence failed after the caller was protected:",
          fallbackError,
        );
      }
    };

    const failGracefully = async (error) => {
      if (failureStarted || intentionalEnd) return;

      failureStarted = true;
      intentionalEnd = true;

      const reason = error?.message || "ConversationRelay failure";
      console.error("ConversationRelay session failure:", error);

      safeSend(socket, {
        type: "text",
        token:
          "I’m sorry, I’m having trouble continuing this call. I’ll connect you with the team or send a text so they can follow up.",
        last: true,
        interruptible: false,
      });

      scheduleFailureEnd(reason);
      await persistFallbackSafely(reason);
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
          // failGracefully is designed not to reject, but keep the event chain
          // contained if a future change accidentally introduces a rejection.
          console.error("ConversationRelay failure handler rejected:", error);
        });
    });

    socket.on("close", (code, reason) => {
      clearTimers();

      messageChain = messageChain
        .then(async () => {
          if (!session?._id) return;
          if (intentionalEnd || session.status === "transferring") return;

          if (code === 1000) {
            try {
              await voiceSessionService.markCompleted(session._id, {
                closeCode: code,
                closeReason: reason.toString(),
              });
            } catch (error) {
              console.error(
                "ConversationRelay could not persist normal completion:",
                error,
              );
            }
            return;
          }

          await persistFallbackSafely(
            `ConversationRelay WebSocket closed with code ${code}: ${reason.toString()}`,
          );
        })
        .catch((error) => {
          console.error("ConversationRelay close handling failed:", error);
        });
    });

    socket.on("error", (error) => {
      void failGracefully(error).catch((handlerError) => {
        console.error(
          "ConversationRelay socket error handler rejected:",
          handlerError,
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
