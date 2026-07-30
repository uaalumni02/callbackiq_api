const escapeXml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;

const trimTrailingSlash = (value) => String(value || "").replace(/\/+$/, "");

export const getVoiceHttpBaseUrl = () =>
  trimTrailingSlash(
    process.env.VOICE_HTTP_PUBLIC_URL ||
      process.env.API_PUBLIC_URL ||
      process.env.PUBLIC_API_URL ||
      "",
  );

export const getVoiceWebSocketUrl = () =>
  String(process.env.VOICE_WEBSOCKET_PUBLIC_URL || "").trim();

export const isConversationRelayConfigured = () =>
  /^https:\/\//i.test(getVoiceHttpBaseUrl()) &&
  /^wss:\/\//i.test(getVoiceWebSocketUrl()) &&
  Boolean(process.env.TWILIO_AUTH_TOKEN);

export const normalizeVoiceSettings = (business) => ({
  voiceAiEnabled: Boolean(business?.features?.voiceAiEnabled),
  answerMode: business?.voiceSettings?.answerMode || "disabled",
  overflowRingSeconds: Math.min(
    60,
    Math.max(5, Number(business?.voiceSettings?.overflowRingSeconds) || 20),
  ),
  transferPhone:
    business?.voiceSettings?.transferPhone || business?.forwardingPhone || "",
  welcomeGreeting:
    business?.voiceSettings?.welcomeGreeting ||
    `Thanks for calling ${business?.businessName || "the business"}. How can I help you today?`,
  voiceName: business?.voiceSettings?.voiceName || "",
  recordingEnabled: Boolean(business?.voiceSettings?.recordingEnabled),
});

export const conversationRelayTwiml = ({
  business,
  voiceSessionId,
  actionPath = "/api/twilio/voice-complete",
}) => {
  const settings = normalizeVoiceSettings(business);
  const baseUrl = getVoiceHttpBaseUrl();
  const actionUrl = `${baseUrl}${actionPath}`;
  const voiceAttribute = settings.voiceName
    ? ` voice="${escapeXml(settings.voiceName)}"`
    : "";

  return xml(
    `<Response><Connect action="${escapeXml(
      actionUrl,
    )}"><ConversationRelay url="${escapeXml(
      getVoiceWebSocketUrl(),
    )}" welcomeGreeting="${escapeXml(
      settings.welcomeGreeting,
    )}" welcomeGreetingInterruptible="any" language="en-US"${voiceAttribute}><Parameter name="voiceSessionId" value="${escapeXml(
      voiceSessionId,
    )}" /><Parameter name="businessId" value="${escapeXml(
      business._id,
    )}" /></ConversationRelay></Connect></Response>`,
  );
};

export const dialTwiml = ({
  transferPhone,
  timeout,
  actionPath = "/api/twilio/voice-overflow",
}) => {
  const baseUrl = getVoiceHttpBaseUrl();
  return xml(
    `<Response><Dial timeout="${Number(timeout)}" answerOnBridge="true" action="${escapeXml(
      `${baseUrl}${actionPath}`,
    )}" method="POST"><Number>${escapeXml(
      transferPhone,
    )}</Number></Dial></Response>`,
  );
};

export const sayTwiml = (message, { hangup = true } = {}) =>
  xml(
    `<Response><Say>${escapeXml(message)}</Say>${
      hangup ? "<Hangup/>" : ""
    }</Response>`,
  );

export const emptyTwiml = () => xml("<Response></Response>");
