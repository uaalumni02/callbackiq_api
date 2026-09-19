import { ownerTextSuppressionReason as reason } from "../../src/services/messaging/ownerTextPolicy.service.js";
const business = { features: { missedCallSmsEnabled: true }, customerMessaging: { configured: true } };
test("existing businesses retain automatic texts unless explicitly disabled", () => {
  expect(reason({ business, source: "missed_call_recovery" })).toBe("");
  expect(reason({ business: {}, source: "voice_fallback" })).toBe("");
  expect(reason({ business: { features: { missedCallSmsEnabled: false } }, source: "voice_fallback" })).toBe("voice_texts_disabled");
});
test.each(["missed_call_recovery", "voice_fallback", "voice_callback_capture", "appointment_reminder", "automation_workflow", "inbound_sms_reply", "unknown_future_automation"])("master off blocks %s", source => {
  expect(reason({ business: { ...business, customerMessaging: { automaticTextsEnabled: false } }, source })).toBe("automatic_customer_texts_disabled");
});
test.each(["manual_sms", "compliance"])("%s remains deliberate and available", usageCategory => {
  expect(reason({ business: { customerMessaging: { automaticTextsEnabled: false } }, usageCategory })).toBe("");
});
test("voice backup choice is independent of missed-call recovery", () => {
  expect(reason({ business: { features: { missedCallSmsEnabled: false }, customerMessaging: { configured: true, voiceTextsEnabled: true } }, source: "voice_callback_capture" })).toBe("");
  expect(reason({ business: { ...business, customerMessaging: { voiceTextsEnabled: false } }, source: "voice_fallback" })).toBe("voice_texts_disabled");
  expect(reason({ business: { ...business, customerMessaging: { voiceTextsEnabled: false } }, source: "appointment_confirmation" })).toBe("");
});
test("appointment controls include confirmations, reminders and changes", () => {
  for (const source of ["appointment_confirmation", "appointment_reminder", "appointment_change_notice"]) expect(reason({ business: { customerMessaging: { appointmentTextsEnabled: false } }, source })).toBe("appointment_texts_disabled");
});
