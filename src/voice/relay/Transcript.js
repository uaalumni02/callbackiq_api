import { logOperationalError, safeSend, toSpokenReply } from './context.js';

export function createRelayTranscript({ state, runtime, socket, request, connectionMeta, voiceTranscriptService }) {
const appendLocalTranscript = (role, text, isFinal = true) => {
      if (!state.session) return;
      if (!Array.isArray(state.session.transcript)) state.session.transcript = [];
      state.session.transcript.push({ role, text, at: new Date(), isFinal });
      if (state.session.transcript.length > 100) state.session.transcript.splice(0, 20);
    };

const appendTranscriptSafely = async ({ role, text, isFinal = true }) => {
      if (!state.session?._id || !String(text || "").trim()) return;
      try {
        await voiceTranscriptService.append({
          sessionId: state.session._id,
          role,
          text,
          isFinal,
        });
      } catch (error) {
        logOperationalError("conversation_relay.transcript_append_failed", error, {
          businessId: state.session?.business?._id || state.session?.business,
          voiceSessionId: state.session?._id,
          role,
        });
      }
      runtime.appendLocalTranscript(role, text, isFinal);
    };

const sendAssistantText = async (
      text,
      { interruptible = true, preemptible = false, record = true } = {},
    ) => {
      const spoken = toSpokenReply(text);
      if (!spoken) return false;
      const sent = safeSend(socket, {
        type: "text",
        token: spoken,
        last: true,
        interruptible,
        preemptible,
      });
      if (sent && record) {
        await runtime.appendTranscriptSafely({ role: "assistant", text: spoken });
      }
      return sent;
    };
return { appendLocalTranscript, appendTranscriptSafely, sendAssistantText };
}
