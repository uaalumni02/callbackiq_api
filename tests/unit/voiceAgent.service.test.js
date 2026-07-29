import Appointment from "../../src/models/appointment.js";
import sendConfirmationSmsTool from "../../src/helpers/ai/tools/sendConfirmationSms.tool.js";
import BookingStateMachineService from "../../src/services/booking/bookingStateMachine.service.js";
import { assessInboundSafety } from "../../src/services/safetyAssessmentService.js";
import VoiceAgentService from "../../src/voice/voiceAgent.service.js";
import VoiceHandoffService from "../../src/voice/voiceHandoff.service.js";

jest.mock("../../src/models/appointment.js", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));

jest.mock("../../src/models/callLog.js", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));

jest.mock("../../src/models/serviceOffering.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

jest.mock("../../src/helpers/ai/tools/searchServices.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/helpers/ai/tools/validateServiceArea.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/helpers/ai/tools/sendConfirmationSms.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/services/booking/bookingStateMachine.service.js", () => ({
  __esModule: true,
  default: { handle: jest.fn() },
}));

jest.mock("../../src/services/safetyAssessmentService.js", () => ({
  __esModule: true,
  assessInboundSafety: jest.fn(),
}));

jest.mock("../../src/voice/voiceAvailability.service.js", () => ({
  __esModule: true,
  default: {
    describeBusinessHours: jest.fn(),
  },
}));

jest.mock("../../src/voice/voiceHandoff.service.js", () => ({
  __esModule: true,
  default: { request: jest.fn() },
}));

const makeSession = () => {
  const lead = {
    _id: "lead-1",
    urgency: "medium",
    notes: "",
    save: jest.fn(),
  };
  const conversation = {
    _id: "conversation-1",
    bookingState: { status: "collecting_service", appointment: null },
    populate: jest.fn().mockResolvedValue(undefined),
  };
  return {
    _id: "voice-session-1",
    providerCallSid: "CA123",
    business: {
      _id: "business-1",
      features: { aiBookingEnabled: true },
    },
    lead,
    conversation,
    transcript: [{ role: "customer", text: "I need help" }],
    save: jest.fn(),
  };
};

describe("VoiceAgentService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assessInboundSafety.mockResolvedValue({ isEmergency: false });
    VoiceHandoffService.request.mockResolvedValue({
      type: "end",
      handoffData: "{}",
    });
    Appointment.findById.mockResolvedValue(null);
  });

  test("runs safety detection before booking and escalates emergencies", async () => {
    const session = makeSession();
    assessInboundSafety.mockResolvedValue({
      isEmergency: true,
      hazardType: "gas",
      reply: "Call 911 now.",
    });

    const result = await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "I smell gas and feel dizzy",
    });

    expect(result.reply).toBe("Call 911 now.");
    expect(session.lead.urgency).toBe("emergency");
    expect(session.lead.save).toHaveBeenCalled();
    expect(VoiceHandoffService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "safety_emergency:gas",
        priority: "critical",
        alertType: "safety_emergency",
      }),
    );
    expect(assessInboundSafety).toHaveBeenCalledWith(
      expect.objectContaining({
        customerMessage: "I smell gas and feel dizzy",
        recentMessages: expect.arrayContaining([
          expect.objectContaining({ direction: "inbound", body: "I need help" }),
        ]),
      }),
    );
    expect(BookingStateMachineService.handle).not.toHaveBeenCalled();
  });

  test("honors an explicit human-transfer request before booking", async () => {
    const session = makeSession();

    const result = await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "Please transfer me to a person",
    });

    expect(result.reply).toMatch(/transferring/i);
    expect(VoiceHandoffService.request).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "customer_requested_human" }),
    );
    expect(BookingStateMachineService.handle).not.toHaveBeenCalled();
  });

  test("reuses the existing booking state machine with the voice channel", async () => {
    const session = makeSession();
    BookingStateMachineService.handle.mockResolvedValue({
      handled: true,
      result: { reply: "Please reply YES to confirm." },
    });

    const result = await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "I need a plumbing appointment",
    });

    expect(BookingStateMachineService.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        business: session.business,
        lead: session.lead,
        conversation: session.conversation,
        channel: "voice",
        source: "voice_booking_state_machine",
      }),
    );
    expect(result.reply).toMatch(/please say yes to confirm/i);
  });

  test("marks a confirmed voice booking recovered and sends one session-scoped confirmation", async () => {
    const session = makeSession();
    const appointment = {
      _id: "appointment-1",
      status: "confirmed",
      estimatedValue: 425,
    };
    BookingStateMachineService.handle.mockImplementation(async () => {
      session.conversation.bookingState.status = "booked";
      session.conversation.bookingState.appointment = appointment._id;
      return {
        handled: true,
        result: { reply: "You’re booked for Monday at 10:00 AM." },
      };
    });
    Appointment.findById.mockResolvedValue(appointment);
    sendConfirmationSmsTool.mockResolvedValue({ sent: true });

    const result = await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "Yes",
    });

    expect(result.reply).toMatch(/booked/i);
    expect(session.appointment).toBe(appointment._id);
    expect(session.estimatedValue).toBe(425);
    expect(session.lead).toMatchObject({
      status: "booked",
      appointment: appointment._id,
      recovered: true,
      recoveredBy: "voice_ai",
    });
    expect(sendConfirmationSmsTool).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: appointment._id,
        voiceSessionId: session._id,
      }),
    );
  });

  test("transfers when provider booking fails", async () => {
    const session = makeSession();
    BookingStateMachineService.handle.mockImplementation(async () => {
      session.conversation.bookingState.status = "failed";
      return {
        handled: true,
        result: { reply: "I’m having trouble confirming that appointment." },
      };
    });

    const result = await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "Yes",
    });

    expect(result.reply).toMatch(/trouble confirming/i);
    expect(VoiceHandoffService.request).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "voice_booking_failed" }),
    );
  });
});
