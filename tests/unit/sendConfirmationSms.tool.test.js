import Appointment from "../../src/models/appointment.js";
import Message from "../../src/models/message.js";
import VoiceSession from "../../src/models/voiceSession.js";
import sendConfirmationSmsTool from "../../src/helpers/ai/tools/sendConfirmationSms.tool.js";
import { isSmsSuppressed } from "../../src/services/messaging/contactPreference.service.js";
import SocketService from "../../src/services/socket.service.js";
import { sendSms } from "../../src/services/twilioSmsService.js";

jest.mock("../../src/models/appointment.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

jest.mock("../../src/models/message.js", () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));

jest.mock("../../src/models/voiceSession.js", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn(), updateOne: jest.fn() },
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
  default: {
    emitMessageCreated: jest.fn(),
    emitConversationUpdated: jest.fn(),
    emitDashboardRefresh: jest.fn(),
  },
}));

describe("voice booking confirmation SMS", () => {
  const appointment = {
    _id: "appointment-1",
    startAt: new Date("2026-08-03T14:00:00.000Z"),
    timezone: "America/New_York",
    status: "confirmed",
  };
  const business = { _id: "business-1", phone: "+14045550101" };
  const lead = {
    _id: "lead-1",
    phone: "+14045550102",
    serviceNeeded: "HVAC diagnostic",
  };
  const conversation = {
    _id: "conversation-1",
    customerPhone: lead.phone,
    save: jest.fn(),
  };
  const baseInput = {
    business,
    lead,
    conversation,
    appointmentId: appointment._id,
    voiceSessionId: "voice-session-1",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    Appointment.findOne.mockResolvedValue(appointment);
    VoiceSession.findOneAndUpdate.mockResolvedValue({ _id: "voice-session-1" });
    VoiceSession.updateOne.mockResolvedValue({ modifiedCount: 1 });
    isSmsSuppressed.mockResolvedValue(false);
    sendSms.mockResolvedValue({ sid: "SM123" });
    Message.create.mockResolvedValue({ _id: "message-1" });
  });

  test("requires a voice session id for idempotency", async () => {
    await expect(
      sendConfirmationSmsTool({ ...baseInput, voiceSessionId: "" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(sendSms).not.toHaveBeenCalled();
  });

  test("suppresses delivery for a caller who opted out", async () => {
    isSmsSuppressed.mockResolvedValue(true);

    const result = await sendConfirmationSmsTool(baseInput);

    expect(result).toEqual(
      expect.objectContaining({ sent: false, suppressed: true }),
    );
    expect(VoiceSession.updateOne).toHaveBeenCalledWith(
      { _id: "voice-session-1" },
      { $set: expect.objectContaining({ confirmationSmsStatus: "suppressed" }) },
    );
    expect(sendSms).not.toHaveBeenCalled();
    expect(Message.create).not.toHaveBeenCalled();
  });

  test("does not resend a confirmation already claimed by another event", async () => {
    VoiceSession.findOneAndUpdate.mockResolvedValue(null);

    const result = await sendConfirmationSmsTool(baseInput);

    expect(result).toEqual(expect.objectContaining({ sent: false, duplicate: true }));
    expect(Appointment.findOne).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  test("sends, persists, and marks a compliant confirmation as sent", async () => {
    const result = await sendConfirmationSmsTool(baseInput);

    expect(VoiceSession.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "voice-session-1" }),
      expect.objectContaining({
        $set: expect.objectContaining({ confirmationSmsStatus: "sending" }),
      }),
      { new: true },
    );
    expect(sendSms).toHaveBeenCalledWith({
      to: lead.phone,
      from: business.phone,
      body: expect.stringContaining("You’re confirmed"),
      source: "appointment_confirmation",
      usageCategory: "appointment_confirmation",
    });
    expect(VoiceSession.updateOne).toHaveBeenCalledWith(
      { _id: "voice-session-1" },
      {
        $set: expect.objectContaining({
          confirmationSmsStatus: "sent",
          confirmationSmsProviderMessageId: "SM123",
        }),
      },
    );
    expect(Message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        business: business._id,
        conversation: conversation._id,
        lead: lead._id,
        providerMessageId: "SM123",
        metadata: expect.objectContaining({ voiceSessionId: "voice-session-1" }),
      }),
    );
    expect(conversation.save).toHaveBeenCalled();
    expect(SocketService.emitMessageCreated).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ sent: true, messagePersisted: true }),
    );
  });

  test("keeps sent status when only local message logging fails", async () => {
    Message.create.mockRejectedValue(new Error("database unavailable"));

    const result = await sendConfirmationSmsTool(baseInput);

    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({ sent: true, messagePersisted: false }),
    );
    expect(VoiceSession.updateOne).toHaveBeenCalledWith(
      { _id: "voice-session-1" },
      {
        $set: expect.objectContaining({ confirmationSmsStatus: "sent" }),
      },
    );
  });

  test("releases the claim for a future retry when Twilio delivery fails", async () => {
    sendSms.mockRejectedValue(new Error("Twilio unavailable"));

    await expect(sendConfirmationSmsTool(baseInput)).rejects.toThrow(
      "Twilio unavailable",
    );
    expect(VoiceSession.updateOne).toHaveBeenCalledWith(
      { _id: "voice-session-1" },
      {
        $set: expect.objectContaining({ confirmationSmsStatus: "failed" }),
      },
    );
  });
  test("owner text suppression is not recorded as a delivered confirmation", async () => {
    sendSms.mockResolvedValue({ suppressed: true, reason: "appointment_texts_disabled", sid: "" });
    const result = await sendConfirmationSmsTool(baseInput);
    expect(result).toMatchObject({ sent: false, suppressed: true, reason: "appointment_texts_disabled" });
    expect(Message.create).not.toHaveBeenCalled();
    expect(conversation.save).not.toHaveBeenCalled();
    expect(VoiceSession.updateOne).toHaveBeenCalledWith({ _id: "voice-session-1" }, { $set: expect.objectContaining({ confirmationSmsStatus: "suppressed" }) });
  });

});
