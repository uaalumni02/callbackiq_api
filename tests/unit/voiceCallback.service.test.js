import Alert from "../../src/models/alert.js";
import Message from "../../src/models/message.js";
import SocketService from "../../src/services/socket.service.js";
import { sendSms } from "../../src/services/twilioSmsService.js";
import VoiceCallbackService from "../../src/voice/voiceCallback.service.js";

jest.mock("../../src/models/alert.js", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn() },
}));
jest.mock("../../src/models/message.js", () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));
jest.mock("../../src/services/twilioSmsService.js", () => ({
  __esModule: true,
  sendSms: jest.fn(),
}));
jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitLeadUpdated: jest.fn(),
    emitConversationUpdated: jest.fn(),
    emitMessageCreated: jest.fn(),
    emitAlertCreated: jest.fn(),
    emitDashboardRefresh: jest.fn(),
  },
}));
jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  __esModule: true,
  logOperationalError: jest.fn(),
  logOperationalWarning: jest.fn(),
}));

const makeSession = () => {
  const lead = {
    _id: "lead-1",
    customerName: "Voice Caller",
    phone: "+14045550111",
    serviceNeeded: "Unknown",
    urgency: "medium",
    address: "",
    preferredAppointmentTime: "",
    status: "new",
    notes: "",
    save: jest.fn().mockResolvedValue(undefined),
  };
  const conversation = {
    _id: "conversation-1",
    customerName: "Voice Caller",
    bookingState: { status: "not_started" },
    humanTakeover: false,
    aiEnabled: true,
    lastMessage: "",
    save: jest.fn().mockResolvedValue(undefined),
  };
  return {
    _id: "session-1",
    providerCallSid: "CA123",
    from: "+14045550111",
    to: "+14045550122",
    status: "active",
    confirmationSmsStatus: "pending",
    confirmationSmsProviderMessageId: "",
    metadata: {},
    transcript: [{ role: "customer", text: "I need drain cleaning" }],
    business: {
      _id: "business-1",
      businessName: "Atlanta Pro Plumbing",
      phone: "+14045550122",
      features: { missedCallSmsEnabled: true },
    },
    lead,
    conversation,
    save: jest.fn().mockResolvedValue(undefined),
  };
};

describe("VoiceCallbackService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Alert.findOneAndUpdate.mockResolvedValue({ _id: "alert-1" });
    Message.create.mockResolvedValue({ _id: "message-1" });
    sendSms.mockResolvedValue({ sid: "SM123", status: "sent" });
  });

  test("collects details, creates an intervention alert, and sends confirmation", async () => {
    const session = makeSession();

    let result = await VoiceCallbackService.handle({
      session,
      customerMessage: "I need drain cleaning",
      reason: "voice_booking_not_enabled",
      seedServiceFromMessage: true,
    });
    expect(result.reply).toMatch(/what name/i);
    expect(session.metadata.callbackCapture.status).toBe("collecting_name");

    result = await VoiceCallbackService.handle({
      session,
      customerMessage: "DeMeco Bell",
    });
    expect(result.reply).toMatch(/address|zip/i);

    result = await VoiceCallbackService.handle({
      session,
      customerMessage: "30303",
    });
    expect(result.reply).toMatch(/how urgent/i);

    result = await VoiceCallbackService.handle({
      session,
      customerMessage: "Today",
    });
    expect(result.reply).toMatch(/what day or time/i);

    result = await VoiceCallbackService.handle({
      session,
      customerMessage: "Tomorrow afternoon",
    });

    expect(result.callbackCaptured).toBe(true);
    expect(JSON.parse(result.handoff.handoffData)).toMatchObject({
      reasonCode: "callback-captured",
      callbackCaptured: true,
    });
    expect(session.lead).toMatchObject({
      customerName: "DeMeco Bell",
      serviceNeeded: "I need drain cleaning",
      address: "30303",
      urgency: "high",
      preferredAppointmentTime: "Tomorrow afternoon",
      status: "new",
    });
    expect(session.conversation).toMatchObject({
      humanTakeover: true,
      aiEnabled: false,
    });
    expect(session.conversation.bookingState.status).toBe("human_takeover");
    expect(Alert.findOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          actionRequired: true,
          title: "Customer callback requested",
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "voice_callback_capture",
        usageCategory: "voice_callback_confirmation",
      }),
    );
    expect(Message.create).toHaveBeenCalled();
    expect(SocketService.emitDashboardRefresh).toHaveBeenCalledWith(
      "business-1",
      "voice_callback_captured",
    );
  });

  test("creates a critical safety alert without promising or texting a callback", async () => {
    const session = makeSession();

    const result = await VoiceCallbackService.handle({
      session,
      customerMessage: "I smell gas",
      reason: "safety_emergency:gas",
      alertType: "safety_emergency",
      priority: "critical",
      seed: {
        serviceNeeded: "Potential gas emergency",
        urgency: "emergency",
      },
      immediate: true,
      sendConfirmationSms: false,
      completionReply: "Call 911 now and do not wait for a callback.",
    });

    expect(result.reply).toMatch(/call 911/i);
    expect(Alert.findOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          type: "safety_emergency",
          priority: "critical",
        }),
      }),
      expect.any(Object),
    );
    expect(sendSms).not.toHaveBeenCalled();
  });

  test("does not resend a provider-accepted SMS when local message logging fails", async () => {
    const session = makeSession();
    Message.create.mockRejectedValueOnce(new Error("database unavailable"));

    await VoiceCallbackService.handle({
      session,
      customerMessage: "",
      reason: "callback_requested",
      requiredFields: [],
      seed: {
        serviceNeeded: "Drain cleaning",
        customerName: "DeMeco Bell",
        location: "30303",
        urgency: "high",
        preferredTime: "Tomorrow afternoon",
      },
      immediate: true,
    });

    expect(session.confirmationSmsStatus).toBe("sent");
    expect(sendSms).toHaveBeenCalledTimes(1);

    await VoiceCallbackService.handle({
      session,
      customerMessage: "",
      reason: "callback_requested",
      requiredFields: [],
      seed: {
        serviceNeeded: "Drain cleaning",
        customerName: "DeMeco Bell",
        location: "30303",
        urgency: "high",
        preferredTime: "Tomorrow afternoon",
      },
      immediate: true,
    });

    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  test("suppresses confirmation when the business disabled missed-call SMS", async () => {
    const session = makeSession();
    session.business.features.missedCallSmsEnabled = false;
    session.lead.customerName = "DeMeco Bell";
    session.lead.serviceNeeded = "Drain cleaning";
    session.lead.address = "30303";
    session.lead.preferredAppointmentTime = "Tomorrow";

    const result = await VoiceCallbackService.handle({
      session,
      customerMessage: "Today",
      reason: "callback_requested",
      seed: {
        urgency: "high",
        urgencyDetail: "Today",
      },
      requiredFields: [],
      immediate: true,
    });

    expect(result.callbackCaptured).toBe(true);
    expect(session.confirmationSmsStatus).toBe("suppressed");
    expect(sendSms).not.toHaveBeenCalled();
  });
});
