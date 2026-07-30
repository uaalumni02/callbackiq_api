import Alert from "../../src/models/alert.js";
import VoiceSession from "../../src/models/voiceSession.js";
import VoiceFailureService from "../../src/voice/voiceFailure.service.js";
import VoiceTranscriptService from "../../src/voice/voiceTranscript.service.js";

jest.mock("../../src/models/alert.js", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn() },
}));

jest.mock("../../src/models/voiceSession.js", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));

jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitAlertCreated: jest.fn(),
    emitDashboardRefresh: jest.fn(),
  },
}));

jest.mock("../../src/voice/voiceTranscript.service.js", () => ({
  __esModule: true,
  default: { finalize: jest.fn() },
}));

const populatedQuery = (session) => ({
  populate: jest.fn().mockResolvedValue(session),
});

describe("VoiceFailureService staff-first persistence", () => {
  beforeEach(() => jest.clearAllMocks());

  test("preserves the transcript audit and creates one high-priority alert without sending SMS", async () => {
    const session = {
      _id: "voice-session-1",
      business: { _id: "business-1" },
      lead: { _id: "lead-1" },
      conversation: { _id: "conversation-1" },
      transcript: [{ role: "customer", text: "The assistant stopped." }],
      metadata: {},
      save: jest.fn().mockResolvedValue(undefined),
    };
    VoiceSession.findById.mockReturnValue(populatedQuery(session));
    Alert.findOneAndUpdate.mockResolvedValue({ _id: "alert-1" });
    VoiceTranscriptService.finalize.mockResolvedValue(undefined);

    await VoiceFailureService.record({
      sessionId: "voice-session-1",
      failureReason: "model unavailable",
    });

    expect(session.failureReason).toBe("model unavailable");
    expect(session.metadata.voiceFailureRecoveryPending).toBe(true);
    expect(session.save).toHaveBeenCalled();
    expect(Alert.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        business: "business-1",
        dedupeKey: "voice_failure:voice-session-1",
      }),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          priority: "high",
          actionRequired: true,
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(VoiceTranscriptService.finalize).toHaveBeenCalledWith(
      "voice-session-1",
    );
  });
});
