export const transcriptText = (session) =>
  (session?.transcript || []).map((entry) => String(entry?.text || "")).join("\n");

export const findTranscriptContamination = ({ sessions, calls }) => {
  const violations = [];
  const byCallSid = new Map(sessions.map((session) => [session.providerCallSid, session]));

  for (const call of calls) {
    const session = byCallSid.get(call.callSid);
    if (!session) {
      violations.push(`missing_session:${call.callSid}`);
      continue;
    }

    const text = transcriptText(session);
    if (!text.includes(call.sentinel)) {
      violations.push(`missing_own_sentinel:${call.callSid}`);
    }

    for (const other of calls) {
      if (other.callSid === call.callSid) continue;
      if (text.includes(other.sentinel)) {
        violations.push(`cross_transcript:${call.callSid}<-${other.callSid}`);
      }
    }
  }

  return violations;
};

export const uniqueStrings = (values) =>
  new Set(values.filter((value) => value !== null && value !== undefined).map(String)).size;
