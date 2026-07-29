import twilio from "twilio";
import { WebSocket, WebSocketServer } from "ws";

import VoiceAgentService from "./voiceAgent.service.js";
import VoiceSessionService from "./voiceSession.service.js";
import VoiceTranscriptService from "./voiceTranscript.service.js";
import { getVoiceWebSocketUrl } from "./voiceRouting.service.js";

const PATH = "/ws/voice";

const rejectUpgrade = (socket, statusCode, message) => {
  if (!socket.destroyed) {
    socket.write(
      `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`,
    );
    socket.destroy();
  }
};

export const validateConversationRelaySignature = (request) => {
  if (process.env.NODE_ENV === "test" && process.env.DISABLE_TWILIO_SIGNATURE_VALIDATION === "true") {
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
  socket.send(JSON.stringify(payload));
  return true;
};

export const initializeConversationRelayServer = (httpServer) => {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const upgradeHandler = (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, "http://localhost").pathname;
    } catch {
      return rejectUpgrade(socket, 400, "Bad Request");
    }
    if (pathname !== PATH) return;
    if (!validateConversationRelaySignature(request)) {
      return rejectUpgrade(socket, 401, "Unauthorized");
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

    const failGracefully = async (error) => {
      if (intentionalEnd) return;
      console.error("ConversationRelay session failure:", error);
      const reason = error?.message || "ConversationRelay failure";
      intentionalEnd = true;
      safeSend(socket, {
        type: "text",
        token:
          "I’m sorry, I’m having trouble continuing this call. I’ll text you now so the team can follow up.",
        last: true,
        interruptible: false,
      });
      if (session?._id) {
        await VoiceSessionService.sendFallbackSms({
          sessionId: session._id,
          failureReason: reason,
        });
      }
      setTimeout(
        () =>
          safeSend(socket, {
            type: "end",
            handoffData: JSON.stringify({
              reasonCode: "voice-failure",
              reason,
              voiceSessionId: session?._id ? String(session._id) : "",
            }),
          }),
        1200,
      ).unref?.();
    };

    socket.on("message", (raw) => {
      messageChain = messageChain
        .then(async () => {
          const message = JSON.parse(raw.toString("utf8"));

          if (message.type === "setup") {
            const voiceSessionId = message.customParameters?.voiceSessionId;
            if (!voiceSessionId) {
              throw new Error("ConversationRelay setup omitted voiceSessionId.");
            }
            session = await VoiceSessionService.activateFromSetup({
              voiceSessionId,
              setup: message,
            });
            await VoiceTranscriptService.append({
              sessionId: session._id,
              role: "system",
              text: "ConversationRelay session connected.",
            });
            return;
          }

          if (message.type === "prompt" && message.last === true) {
            if (!session) throw new Error("Prompt received before setup.");
            const customerMessage = String(message.voicePrompt || "").trim();
            if (!customerMessage) return;

            await VoiceTranscriptService.append({
              sessionId: session._id,
              role: "customer",
              text: customerMessage,
            });
            session = await VoiceSessionService.activateFromSetup({
              voiceSessionId: session._id,
              setup: {
                callSid: session.providerCallSid,
                sessionId: session.providerSessionId,
                from: session.from,
                to: session.to,
                customParameters: { businessId: String(session.business._id) },
              },
            });
            const result = await VoiceAgentService.handlePrompt({
              session,
              customerMessage,
            });
            const reply = String(result.reply || "").trim();
            if (reply) {
              await VoiceTranscriptService.append({
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
              setTimeout(() => safeSend(socket, result.handoff), 900).unref?.();
            }
            return;
          }

          if (message.type === "error") {
            throw new Error(message.description || "ConversationRelay error");
          }
        })
        .catch(failGracefully);
    });

    socket.on("close", (code, reason) => {
      messageChain = messageChain.then(async () => {
        if (!session?._id) return;
        if (intentionalEnd || session.status === "transferring") return;
        if (code === 1000) {
          await VoiceSessionService.markCompleted(session._id, {
            closeCode: code,
            closeReason: reason.toString(),
          });
          return;
        }
        await VoiceSessionService.sendFallbackSms({
          sessionId: session._id,
          failureReason: `ConversationRelay WebSocket closed with code ${code}: ${reason.toString()}`,
        });
      });
    });

    socket.on("error", (error) => {
      void failGracefully(error);
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
