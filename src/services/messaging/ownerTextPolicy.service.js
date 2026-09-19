// Central outbound policy. Manual replies and compliance commands are deliberate exceptions.
export const ownerTextSuppressionReason = ({ business, source = "", usageCategory = "" }) => {
  if (usageCategory === "manual_sms" || usageCategory === "compliance") return "";
  const policy = business?.customerMessaging || {};
  if (policy.automaticTextsEnabled === false) return "automatic_customer_texts_disabled";
  if ((source.startsWith("voice_") || usageCategory.startsWith("voice_")) && (policy.voiceTextsEnabled === false || !policy.configured && business?.features?.missedCallSmsEnabled === false)) return "voice_texts_disabled";
  if (policy.appointmentTextsEnabled === false && (source.startsWith("appointment_") || usageCategory.startsWith("appointment_"))) return "appointment_texts_disabled";
  if (business?.features?.missedCallSmsEnabled === false && ["missed_call_recovery", "inbound_sms_reply", "inbound_sms_deterministic_reply"].includes(source)) return "missed_call_texts_disabled";
  return "";
};
