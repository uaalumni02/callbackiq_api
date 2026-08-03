import VoiceSession from "../models/voiceSession.js";
import * as Guardrails from "../helpers/ai/aiGuardrails.js";

const ALLOWED_ROLES = new Set(["customer", "assistant", "system"]);
const clean = (value, maximum = 4000) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
const redact = (value) => {
  const normalized = clean(value);
  if (!normalized) return "";
  return typeof Guardrails.redactSensitiveData === "function"
    ? clean(Guardrails.redactSensitiveData(normalized))
    : normalized;
};

class VoiceTranscriptService {
  static async append({ sessionId, role, text, isFinal = true }) {
    const normalizedRole = ALLOWED_ROLES.has(role) ? role : "system";
    const normalized = redact(text);
    if (!sessionId || !normalized) return null;
    return VoiceSession.findByIdAndUpdate(
      sessionId,
      {
        $push: {
          transcript: {
            role: normalizedRole,
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

  static async touch(sessionId, metadata = {}) {
    if (!sessionId) return null;
    const $set = { lastActivityAt: new Date() };
    for (const [key, value] of Object.entries(metadata || {})) {
      if (!key || key.includes("$") || key.includes("\0")) continue;
      $set[`metadata.${key}`] = value;
    }
    return VoiceSession.findByIdAndUpdate(
      sessionId,
      { $set },
      { returnDocument: "after" },
    );
  }

  static async markLastAssistantInterrupted(sessionId) {
    const session = await VoiceSession.findById(sessionId).select("transcript metadata");
    if (!session) return null;
    const transcript = session.transcript || [];
    let index = transcript.length - 1;
    while (index >= 0 && transcript[index]?.role !== "assistant") index -= 1;
    if (index < 0) return session;

    return VoiceSession.findByIdAndUpdate(
      sessionId,
      {
        $set: {
          [`transcript.${index}.isFinal`]: false,
          "metadata.lastAssistantInterruptedAt": new Date().toISOString(),
          lastActivityAt: new Date(),
        },
        $inc: { "metadata.interruptedAssistantTurns": 1 },
      },
      { returnDocument: "after" },
    );
  }

  static getLastAssistantText(session) {
    return (
      [...(session?.transcript || [])]
        .reverse()
        .find((entry) => entry?.role === "assistant" && entry?.isFinal !== false)
        ?.text || ""
    );
  }

  static buildSummary(transcript = []) {
    const finalEntries = transcript.filter(
      (entry) => entry?.isFinal !== false && clean(entry?.text),
    );
    const customerEntries = finalEntries.filter(
      (entry) => entry.role === "customer",
    );
    const latestCustomer = redact(customerEntries.at(-1)?.text || "");
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
