import VoiceSession from "../../src/models/voiceSession.js";
import VoiceSessionService from "../../src/voice/voiceSession.service.js";

jest.mock("../../src/models/alert.js", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../src/models/callLog.js", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../src/models/lead.js", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../src/models/message.js", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../src/models/voiceSession.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    findById: jest.fn(),
  },
}));

jest.mock("../../src/services/twilioSmsService.js", () => ({
  __esModule: true,
  sendSms: jest.fn(),
}));

jest.mock(
  "../../src/services/messaging/contactPreference.service.js",
  () => ({
    __esModule: true,
    isSmsSuppressed: jest.fn(),
  }),
);

jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  __esModule: true,
  logOperationalError: jest.fn(),
  logOperationalWarning: jest.fn(),
}));

jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../src/voice/voiceLineType.service.js", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../src/voice/voicePhone.service.js", () => ({
  __esModule: true,
  normalizePhoneToE164: jest.fn((value) => value),
  isUsableCallerId: jest.fn(() => true),
}));

jest.mock("../../src/voice/voiceTranscript.service.js", () => ({
  __esModule: true,
  default: {},
}));

const populatedQuery = (value) => ({
  populate: jest.fn().mockResolvedValue(value),
});

describe("VoiceSessionService initial context upsert", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    VoiceSession.findOneAndUpdate.mockResolvedValue({
      _id: "voice-session-1",
      lead: "lead-1",
      conversation: "conversation-1",
      callLog: "call-log-1",
    });
    VoiceSession.findById.mockImplementation(() =>
      populatedQuery({ _id: "voice-session-1" }),
    );
  });

  test("does not update metadata parent and child paths in one upsert", async () => {
    await VoiceSessionService.ensureContext({
      business: { _id: "business-1" },
      from: "+14045550100",
      to: "+14045550101",
      providerCallSid: "CA123",
    });

    const [, update, options] = VoiceSession.findOneAndUpdate.mock.calls[0];

    expect(update.$setOnInsert.metadata).toBeUndefined();
    expect(update.$set["metadata.callerIdUsable"]).toBe(true);
    expect(
      update.$set["metadata.originalCallerIdClassification"],
    ).toBe("usable");
    expect(options).toEqual(
      expect.objectContaining({
        upsert: true,
        returnDocument: "after",
        setDefaultsOnInsert: true,
      }),
    );
  });
});
