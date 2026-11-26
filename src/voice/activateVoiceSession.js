import { assertProviderEntitlement } from "../services/providerEntitlement.service.js";
const assertSetupIdentity = (session, setup, TERMINAL_STATUSES) => {
  if (session.providerCallSid !== setup.callSid) {
    throw new Error(
      "ConversationRelay CallSid did not match the voice session.",
    );
  }
  if (
    setup.customParameters?.businessId &&
    String(session.business?._id || session.business) !==
      String(setup.customParameters.businessId)
  ) {
    throw new Error("ConversationRelay business scope did not match.");
  }
  if (TERMINAL_STATUSES.has(session.status)) {
    const error = new Error(
      `ConversationRelay cannot activate a terminal ${session.status} session.`,
    );
    error.code = "VOICE_SESSION_TERMINAL";
    throw error;
  }
  if (
    session.providerSessionId &&
    setup.sessionId &&
    session.providerSessionId !== setup.sessionId
  ) {
    const error = new Error(
      "ConversationRelay SessionId changed unexpectedly.",
    );
    error.code = "VOICE_SESSION_ID_MISMATCH";
    throw error;
  }
};
/** Activates only a scoped live paid session; identity/entitlement mismatch throws before activation. */
export async function activateVoiceSession(
  { voiceSessionId, setup },
  {
    VoiceSession,
    populateSession,
    TERMINAL_STATUSES,
    normalizePhoneToE164,
    recordCallAnswer,
  },
) {
  const session = await populateSession(VoiceSession.findById(voiceSessionId));
  if (!session) throw new Error("Voice session was not found.");
  await assertProviderEntitlement(
    session.business?._id || session.business,
    "voice",
  );
  assertSetupIdentity(session, setup, TERMINAL_STATUSES);

  const nextStatus = ["routing", "connecting"].includes(session.status)
    ? "active"
    : session.status;
  const from = normalizePhoneToE164(setup.from);
  const to = normalizePhoneToE164(setup.to);
  const update = {
    providerSessionId: setup.sessionId || session.providerSessionId,
    signatureValidated: true,
    status: nextStatus,
    lastActivityAt: new Date(),
    "metadata.accountSid": String(setup.accountSid || "").slice(0, 80),
    "metadata.callType": String(setup.callType || "").slice(0, 80),
    "metadata.direction": String(setup.direction || "").slice(0, 80),
    "metadata.setupReceivedAt": new Date().toISOString(),
  };
  if (from) update.from = from;
  if (to) update.to = to;

  await recordCallAnswer({
    businessId: session.business?._id || session.business,
    callLogId: session.callLog?._id || session.callLog,
    answeredBy: "ai",
  });
  return VoiceSession.findByIdAndUpdate(
    session._id,
    { $set: update },
    { returnDocument: "after" },
  ).populate(["business", "lead", "conversation", "callLog", "appointment"]);
}
