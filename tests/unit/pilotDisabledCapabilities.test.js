import { normalizeVoiceSettings } from "../../src/voice/voiceRouting.service.js";
import {
  getBusinessFeatures,
  isBusinessFeatureEnabled,
} from "../../src/helpers/businessFeatures.js";
test("H03 a legacy live-transfer toggle cannot enable transfer during the callback-only pilot", () => {
  const value = normalizeVoiceSettings({
    features: { voiceAiEnabled: true },
    voiceSettings: {
      liveTransferEnabled: true,
      liveTransferPhone: "+15555550112",
    },
  });
  expect(value.liveTransferEnabled).toBe(false);
  expect(value.liveTransferPhone).toBe("");
});
test("H08 legacy Jobber flags remain off during the pilot", () => {
  const business = {
    features: { jobberEnabled: true, calendarProvider: "jobber" },
  };
  expect(isBusinessFeatureEnabled(business, "jobberEnabled")).toBe(false);
  expect(getBusinessFeatures(business).calendarProvider).toBe("internal");
});
