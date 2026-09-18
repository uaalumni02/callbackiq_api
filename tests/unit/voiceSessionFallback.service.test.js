import { claimRecoveryIntroduction } from "../../src/services/messaging/recoveryIntroduction.service.js";
jest.mock("../../src/services/messaging/recoveryIntroduction.service.js", () => ({ claimRecoveryIntroduction: jest.fn() }));
import Alert from "../../src/models/alert.js";
import Message from "../../src/models/message.js";
import VoiceSession from "../../src/models/voiceSession.js";
import { isSmsSuppressed } from "../../src/services/messaging/contactPreference.service.js";
import { sendSms } from "../../src/services/twilioSmsService.js";
import VoiceSessionService from "../../src/voice/voiceSession.service.js";
import VoiceTranscriptService from "../../src/voice/voiceTranscript.service.js";

jest.mock("../../src/models/alert.js", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn() },
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
  default: { create: jest.fn() },
}));

jest.mock("../../src/models/voiceSession.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  },
}));

jest.mock("../../src/services/messaging/contactPreference.service.js", () => ({
  __esModule: true,
  isSmsSuppressed: jest.fn(),
}));

jest.mock("../../src/services/twilioSmsService.js", () => ({
  __esModule: true,
  sendSms: jest.fn(),
}));

jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../src/voice/voiceTranscript.service.js", () => ({
  __esModule: true,
  default: { finalize: jest.fn() },
}));

const populatedQuery = (value) => ({
  populate: jest.fn().mockResolvedValue(value),
});

describe("VoiceSessionService fallback", () => {
  let callLog;
  let conversation;
  let session;

  beforeEach(() => {
    jest.clearAllMocks();
    claimRecoveryIntroduction.mockResolvedValue(true);
    callLog = {
      status: "answered",
      missedCallTextSent: false,
      save: jest.fn(),
    };
    conversation = { _id: "conversation-1", save: jest.fn() };
    session = {
      _id: "voice-session-1",
      from: "+14045550100",
      to: "+14045550101",
      business: {
        _id: "business-1",
        businessName: "Peachtree Plumbing",
        phone: "+14045550101",
        smsTemplate: "Sorry we missed your call.",
        features: { missedCallSmsEnabled: true },
      },
      lead: { _id: "lead-1" },
      conversation,
      callLog,
      transcript: [{ role: "customer", text: "My AC is out." }],
      metadata: {},
    };

    VoiceSession.findOneAndUpdate.mockResolvedValue({ _id: session._id });
    VoiceSession.findById.mockImplementation(() => populatedQuery(session));
    VoiceSession.findByIdAndUpdate.mockResolvedValue({ _id: session._id });
    Alert.findOneAndUpdate.mockResolvedValue({ _id: "alert-1" });
    VoiceTranscriptService.finalize.mockResolvedValue(session);
    isSmsSuppressed.mockResolvedValue(false);
    sendSms.mockResolvedValue({ sid: "SM-fallback-1" });
    Message.create.mockResolvedValue({ _id: "message-1" });
  });

  test("suppresses the fallback SMS when the caller opted out", async () => {
    isSmsSuppressed.mockResolvedValue(true);

    await VoiceSessionService.sendFallbackSms({
      sessionId: session._id,
      failureReason: "voice transport failed",
    });

    expect(sendSms).not.toHaveBeenCalled();
    expect(Message.create).not.toHaveBeenCalled();
    expect(VoiceSession.findByIdAndUpdate).toHaveBeenCalledWith(
      session._id,
      expect.objectContaining({
        $set: expect.objectContaining({ fallbackSmsStatus: "suppressed" }),
      }),
    );
    expect(Alert.findOneAndUpdate).toHaveBeenCalled();
    expect(callLog.missedCallTextSent).toBe(false);
  });

  test("marks delivery sent before local persistence work", async () => {
    await VoiceSessionService.sendFallbackSms({
      sessionId: session._id,
      failureReason: "voice transport failed",
    });

    const sentUpdateIndex = VoiceSession.findByIdAndUpdate.mock.calls.findIndex(
      ([, update]) => update?.$set?.fallbackSmsStatus === "sent",
    );
    expect(sentUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(VoiceSession.findByIdAndUpdate.mock.calls[sentUpdateIndex][1]).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({
          fallbackSmsProviderMessageId: "SM-fallback-1",
        }),
      }),
    );
    expect(Message.create).toHaveBeenCalled();
    expect(callLog.missedCallTextSent).toBe(true);
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("does not monitor emergencies or dispatch emergency help") }));
  });

  test("does not reset sent status when only local logging fails", async () => {
    Message.create.mockRejectedValue(new Error("database unavailable"));

    await VoiceSessionService.sendFallbackSms({
      sessionId: session._id,
      failureReason: "voice transport failed",
    });

    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(VoiceSession.findByIdAndUpdate).toHaveBeenCalledWith(
      session._id,
      expect.objectContaining({
        $set: expect.objectContaining({ fallbackSmsStatus: "sent" }),
      }),
    );
    expect(VoiceSession.findByIdAndUpdate).not.toHaveBeenCalledWith(
      session._id,
      expect.objectContaining({
        $set: expect.objectContaining({ fallbackSmsStatus: "failed" }),
      }),
    );
  });

  test("releases the fallback claim when Twilio delivery fails", async () => {
    sendSms.mockRejectedValue(new Error("Twilio unavailable"));

    await VoiceSessionService.sendFallbackSms({
      sessionId: session._id,
      failureReason: "voice transport failed",
    });

    expect(VoiceSession.findByIdAndUpdate).toHaveBeenCalledWith(
      session._id,
      expect.objectContaining({
        $set: expect.objectContaining({ fallbackSmsStatus: "failed" }),
      }),
    );
    expect(Message.create).not.toHaveBeenCalled();
  });

  test("does not send again when another event already completed the claim", async () => {
    VoiceSession.findOneAndUpdate.mockResolvedValue(null);

    await VoiceSessionService.sendFallbackSms({
      sessionId: session._id,
      failureReason: "duplicate callback",
    });

    expect(sendSms).not.toHaveBeenCalled();
    expect(Message.create).not.toHaveBeenCalled();
  });
  test("shared introduction cooldown suppresses a separate voice call", async () => {
    claimRecoveryIntroduction.mockResolvedValue(false);
    await VoiceSessionService.sendFallbackSms({ sessionId: session._id });
    expect(sendSms).not.toHaveBeenCalled();
    expect(VoiceSession.findByIdAndUpdate).toHaveBeenCalledWith(session._id,
      expect.objectContaining({ $set: expect.objectContaining({ fallbackSmsStatus: "suppressed" }) }));
  });

  test("a failed fallback retry uses the same SMS operation identity", async () => {
    session.providerCallSid = "CA-stable";
    sendSms.mockRejectedValueOnce(new Error("uncertain send"));
    await VoiceSessionService.sendFallbackSms({ sessionId: session._id });
    await VoiceSessionService.sendFallbackSms({ sessionId: session._id });
    const keys = sendSms.mock.calls.map(([args]) => args.metadata.idempotencyKey);
    expect(keys).toEqual(["missed-call-recovery:business-1:CA-stable", "missed-call-recovery:business-1:CA-stable"]);
  });

  test("claim store failure cannot reach the SMS provider and remains retryable", async () => {
    claimRecoveryIntroduction.mockRejectedValue(new Error("claim unavailable"));
    await expect(VoiceSessionService.sendFallbackSms({ sessionId: session._id })).rejects.toThrow("claim unavailable");
    expect(sendSms).not.toHaveBeenCalled();
    expect(VoiceSession.findByIdAndUpdate).toHaveBeenCalledWith(session._id, { $set: { fallbackSmsStatus: "failed" } });
  });

  test("a read-only overlapping session does not send a fallback introduction", async () => {
    session.metadata.sharedRequestReadOnly = true;
    await VoiceSessionService.sendFallbackSms({ sessionId: session._id });
    expect(sendSms).not.toHaveBeenCalled();
    expect(claimRecoveryIntroduction).not.toHaveBeenCalled();
  });

});
