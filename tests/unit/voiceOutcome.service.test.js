jest.mock("../../src/models/voiceSession.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  },
}));
jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: {
    findByIdAndUpdate: jest.fn(),
  },
}));
jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitConversationUpdated: jest.fn(),
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
import Conversation from "../../src/models/conversation.js";
import VoiceSessionService from "../../src/voice/voiceSession.service.js";
import AlertService from "../../src/services/alert.service.js";
import {
  commitVoiceOutcome,
  inferVoiceOutcome,
  recoverAbandonedVoiceCall,
} from "../../src/voice/voiceOutcome.service.js";

test("infers committed outcomes from durable artifacts", () => {
  expect(inferVoiceOutcome({ appointment: "appointment-1" })).toBe("booked");
  expect(inferVoiceOutcome({ metadata: { callbackCapture: { status: "completed", reason: "callback_requested" } } })).toBe("callback_saved");
  expect(inferVoiceOutcome({ status: "active" })).toBe("");
});


test("claims conversation ownership only after a screened voice transfer is accepted", async () => {
  const now = new Date("2026-09-05T14:00:00.000Z");
  VoiceSession.findOneAndUpdate.mockResolvedValueOnce({
    _id: "session-accepted",
    business: "business-1",
    conversation: "conversation-1",
  });
  Conversation.findByIdAndUpdate.mockResolvedValueOnce({
    _id: "conversation-1",
    humanTakeover: true,
    aiEnabled: false,
  });

  const result = await commitVoiceOutcome({
    sessionId: "session-accepted",
    outcome: "transfer_accepted",
    status: "completed",
    now,
  });

  expect(result.committed).toBe(true);
  expect(Conversation.findByIdAndUpdate).toHaveBeenCalledWith(
    "conversation-1",
    expect.objectContaining({
      $set: expect.objectContaining({
        humanTakeover: true,
        aiEnabled: false,
        "bookingState.status": "human_takeover",
        "orchestration.phase": "human_takeover",
      }),
    }),
    expect.objectContaining({ returnDocument: "after" }),
  );
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

test('pending business approval is a durable request outcome, not a confirmed booking', () => {
 expect(inferVoiceOutcome({metadata:{bookingRequestSubmittedAt:'2026-09-24T02:46:00Z'}})).toBe('appointment_requested');
});
