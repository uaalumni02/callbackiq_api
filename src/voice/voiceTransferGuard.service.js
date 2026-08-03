const ACCEPT_DIGIT = "1";

export const buildAgentConfirmationTwiml = ({
  voiceSessionId,
  callbackUrl,
  callerSummary = "A customer is requesting a live transfer.",
}) => {
  const safeSummary = String(callerSummary || "").slice(0, 400);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" timeout="8" action="${callbackUrl}" method="POST">
    <Say>${safeSummary} Press ${ACCEPT_DIGIT} to accept the call.</Say>
  </Gather>
  <Redirect method="POST">${callbackUrl}?VoiceSessionId=${encodeURIComponent(
    voiceSessionId || "",
  )}&amp;Digits=</Redirect>
</Response>`;
};

export const classifyTransferAcceptance = ({
  answeredBy,
  digits,
  dialCallStatus,
}) => {
  const normalizedAnswer = String(answeredBy || "").toLowerCase();
  const normalizedStatus = String(dialCallStatus || "").toLowerCase();
  const accepted = String(digits || "") === ACCEPT_DIGIT;

  if (["machine_start", "machine_end_beep", "fax"].includes(normalizedAnswer)) {
    return { accepted: false, reason: "answering_machine_detected" };
  }
  if (["busy", "failed", "no-answer", "canceled"].includes(normalizedStatus)) {
    return { accepted: false, reason: `transfer_${normalizedStatus}` };
  }
  if (!accepted) return { accepted: false, reason: "agent_did_not_accept" };
  return { accepted: true, reason: "agent_confirmed" };
};

export const buildGuardedDialOptions = ({
  statusCallback,
  action,
  timeoutSeconds = 20,
}) => ({
  answerOnBridge: true,
  timeout: Math.min(45, Math.max(8, Number(timeoutSeconds) || 20)),
  action,
  method: "POST",
  machineDetection: "Enable",
  asyncAmd: true,
  asyncAmdStatusCallback: statusCallback,
  asyncAmdStatusCallbackMethod: "POST",
});

export default {
  buildAgentConfirmationTwiml,
  classifyTransferAcceptance,
  buildGuardedDialOptions,
};
