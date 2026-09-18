import Lead from "../../src/models/lead.js";
import Conversation from "../../src/models/conversation.js";
import CallLog from "../../src/models/callLog.js";
import VoiceSession from "../../src/models/voiceSession.js";
import VoiceSessionService from "../../src/voice/voiceSession.service.js";
import {
  resolveTrackingNumberContext,
  syncLatestAttribution,
} from "../../src/services/marketingAttribution.service.js";

jest.mock("../../src/services/marketingAttribution.service.js", () => ({
  __esModule: true,
  resolveTrackingNumberContext: jest.fn(),
  syncLatestAttribution: jest.fn(),
}));

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
  default: { emitConversationUpdated: jest.fn() },
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
    resolveTrackingNumberContext.mockResolvedValue(null);
    syncLatestAttribution.mockResolvedValue(null);
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
  test.each([false, true])("closed conversation reuse survives a concurrent insert: %s", async race => {
    const lead = { _id: "lead-1", customerName: "Returning customer" };
    const conversation = { _id: "conversation-1", lead: "lead-1", status: "closed" };
    Lead.findOne = jest.fn(() => ({ sort: jest.fn().mockResolvedValue(lead) }));
    Conversation.findOne = jest.fn(() => ({ sort: jest.fn().mockResolvedValue(conversation) }));
    if (race) Conversation.findOne.mockReturnValueOnce({ sort: jest.fn().mockResolvedValue(null) });
    Conversation.create = jest.fn().mockRejectedValue(Object.assign(new Error("duplicate active record"), { code: 11000 }));
    CallLog.findOne = jest.fn().mockResolvedValue({ _id: "call-log-1" });
    VoiceSession.findOneAndUpdate.mockResolvedValue({ _id: "voice-session-1" });
    VoiceSession.findByIdAndUpdate = jest.fn().mockResolvedValue({ _id: "voice-session-1" });
    await VoiceSessionService.ensureContext({ business: { _id: "business-1" }, from: "+14045550100", to: "+14045550101", providerCallSid: "CA-returning" });
    expect(Conversation.findOne.mock.calls.every(([filter]) => filter.status.$ne === "archived")).toBe(true);
    expect(VoiceSession.findByIdAndUpdate).toHaveBeenCalledWith("voice-session-1", expect.objectContaining({ $set: expect.objectContaining({ conversation: "conversation-1" }) }), expect.any(Object));
    if (!race) expect(Conversation.create).not.toHaveBeenCalled();
  });

  test("voice repairs an orphaned conversation before attaching the session", async () => {
    const business = { _id: "business-1" };
    const lead = { _id: "lead-1", business: business._id, phone: "+14045550100" };
    const conversation = { _id: "conversation-1", business: business._id,
      lead: "deleted-lead", customerPhone: lead.phone, status: "open", humanTakeover: false };
    Lead.findOne = jest.fn().mockReturnValueOnce({ sort: jest.fn().mockResolvedValue(lead) }).mockResolvedValueOnce(null);
    Conversation.findOne = jest.fn(() => ({ sort: jest.fn().mockResolvedValue(conversation) }));
    Conversation.findOneAndUpdate = jest.fn().mockResolvedValue({ ...conversation, lead: lead._id });
    CallLog.findOne = jest.fn().mockResolvedValue({ _id: "call-log-1" });
    VoiceSession.findOneAndUpdate.mockResolvedValue({ _id: "voice-session-1" });
    VoiceSession.findByIdAndUpdate = jest.fn().mockResolvedValue({ _id: "voice-session-1" });
    await VoiceSessionService.ensureContext({ business, from: lead.phone, to: "+14045550101", providerCallSid: "CA-orphan" });
    expect(Conversation.findOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({ lead: "deleted-lead", business: business._id }), expect.any(Object), expect.any(Object));
    expect(VoiceSession.findByIdAndUpdate).toHaveBeenCalledWith("voice-session-1", expect.objectContaining({ $set: expect.objectContaining({ lead: lead._id, conversation: conversation._id }) }), expect.any(Object));
  });

});
