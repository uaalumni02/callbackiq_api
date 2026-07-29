import VoiceSession from "../models/voiceSession.js";

const normalizeText = (value) => String(value || "").trim().slice(0, 4000);

class VoiceTranscriptService {
  static async append({ sessionId, role, text, isFinal = true }) {
    const normalized = normalizeText(text);
    if (!sessionId || !normalized) return null;

    return VoiceSession.findByIdAndUpdate(
      sessionId,
      {
        $push: {
          transcript: {
            role,
            text: normalized,
            at: new Date(),
            isFinal: Boolean(isFinal),
          },
        },
        $set: { lastActivityAt: new Date() },
      },
      { returnDocument: "after" },
    );
  }

  static buildSummary(transcript = []) {
    const finalEntries = transcript.filter(
      (entry) => entry?.isFinal !== false && String(entry?.text || "").trim(),
    );
    const customerEntries = finalEntries.filter(
      (entry) => entry.role === "customer",
    );
    const latestCustomer = customerEntries.at(-1)?.text || "";
    const turns = customerEntries.length;

    if (!turns) return "Voice session ended before the caller provided details.";

    return `Voice session captured ${turns} caller turn${
      turns === 1 ? "" : "s"
    }. Latest caller statement: ${latestCustomer}`.slice(0, 4000);
  }

  static async finalize(sessionId) {
    const session = await VoiceSession.findById(sessionId);
    if (!session) return null;

    session.summary = this.buildSummary(session.transcript || []);
    session.lastActivityAt = new Date();
    await session.save();
    return session;
  }
}

export default VoiceTranscriptService;
