jest.mock("../../src/models/voiceSession.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  },
}));
jest.mock("../../src/voice/voiceSession.service.js", () => ({
  __esModule: true,
  default: { sendFallbackSms: jest.fn().mockResolvedValue({ fallbackSmsStatus: "sent" }) },
}));
jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: { createAutomatic: jest.fn().mockResolvedValue({ created: true }) },
}));

import VoiceSession from "../../src/models/voiceSession.js";
import VoiceSessionService from "../../src/voice/voiceSession.service.js";
import AlertService from "../../src/services/alert.service.js";
import { inferVoiceOutcome, recoverAbandonedVoiceCall } from "../../src/voice/voiceOutcome.service.js";

test("infers committed outcomes from durable artifacts", () => {
  expect(inferVoiceOutcome({ appointment: "appointment-1" })).toBe("booked");
  expect(inferVoiceOutcome({ metadata: { callbackCapture: { status: "completed", reason: "callback_requested" } } })).toBe("callback_saved");
  expect(inferVoiceOutcome({ status: "active" })).toBe("");
});

test("concurrent abandonment recovery claims send one SMS and one alert", async () => {
  const session = { _id: "session-1", providerCallSid: "CA1", business: { _id: "business-1" }, lead: { _id: "lead-1" }, metadata: {} };
  let claimed = false;
  VoiceSession.findOneAndUpdate.mockImplementation(() => ({
    populate: async () => {
      if (claimed) return null;
      claimed = true;
      return session;
    },
  }));
  const results = await Promise.all([
    recoverAbandonedVoiceCall({ sessionId: "session-1", closeCode: 1000 }),
    recoverAbandonedVoiceCall({ sessionId: "session-1", closeCode: 1000 }),
  ]);
  expect(results.filter((r) => r.recovered)).toHaveLength(1);
  expect(VoiceSessionService.sendFallbackSms).toHaveBeenCalledTimes(1);
  expect(AlertService.createAutomatic).toHaveBeenCalledTimes(1);
});
