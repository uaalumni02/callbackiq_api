import ServiceOffering from "../../src/models/serviceOffering.js";
import Appointment from "../../src/models/appointment.js";
import searchServicesTool from "../../src/helpers/ai/tools/searchServices.tool.js";
import sendConfirmationSmsTool from "../../src/helpers/ai/tools/sendConfirmationSms.tool.js";
import BookingStateMachineService from "../../src/services/booking/bookingStateMachine.service.js";
import { assessInboundSafety } from "../../src/services/safetyAssessmentService.js";
import VoiceAgentService from "../../src/voice/voiceAgent.service.js";
import VoiceCallbackService from "../../src/voice/voiceCallback.service.js";
import VoiceHandoffService from "../../src/voice/voiceHandoff.service.js";
import VoiceAvailabilityService from "../../src/voice/voiceAvailability.service.js";
import VoiceUnderstandingService from "../../src/voice/voiceUnderstanding.service.js";

import {
  classifyOperationalUrgency,
} from "../../src/services/scheduling/customerSchedulingIntent.service.js";

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
    isBusinessOpen: jest.fn(),
  },
}));
jest.mock("../../src/voice/voiceCallback.service.js", () => ({
  __esModule: true,
  default: {
    isActive: jest.fn(),
    handle: jest.fn(),
  },
}));
jest.mock("../../src/voice/voiceHandoff.service.js", () => ({
  __esModule: true,
  default: { request: jest.fn() },
}));

jest.mock("../../src/voice/voiceUnderstanding.service.js", () => ({
  __esModule: true,
  default: {
    classifyVoiceTurn: jest.fn(),
  },
}));

const makeSession = () => {
  const lead = {
    _id: "lead-1",
    customerName: "Voice Caller",
    serviceNeeded: "Unknown",
    urgency: "medium",
    notes: "",
    save: jest.fn(),
  };
  const conversation = {
    _id: "conversation-1",
    bookingState: { status: "not_started", appointment: null },
    populate: jest.fn().mockResolvedValue(undefined),
  };
  return {
    _id: "voice-session-1",
    providerCallSid: "CA123",
    business: {
      _id: "business-1",
      forwardingPhone: "+14045550100",
      features: { aiBookingEnabled: true },
      voiceSettings: {
        liveTransferEnabled: false,
        transferPhone: "+14045550100",
        liveTransferPhone: "+14045550199",
      },
    },
    lead,
    conversation,
    transcript: [{ role: "customer", text: "I need help" }],
    save: jest.fn(),
  };
};

describe("VoiceAgentService callback-first recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assessInboundSafety.mockResolvedValue({ isEmergency: false });
    VoiceUnderstandingService.classifyVoiceTurn.mockImplementation(
      async ({ customerMessage }) => ({
        intent: "other",
        language: "en",
        directedAbuse: false,
        situationProfanity: false,
        entities: {
          service: "",
          name: "",
          location: "",
          city: "",
          postalCode: "",
          urgency: "",
          preference: "",
        },
        safety: await assessInboundSafety(customerMessage),
      }),
    );
    VoiceCallbackService.isActive.mockReturnValue(false);
    VoiceCallbackService.handle.mockResolvedValue({
      reply: "I created a callback request.",
      callbackCaptured: false,
    });
    VoiceHandoffService.request.mockResolvedValue({
      type: "end",
      handoffData: "{}",
    });
    searchServicesTool.mockResolvedValue([]);
    VoiceAvailabilityService.isBusinessOpen.mockResolvedValue(true);
    Appointment.findById.mockResolvedValue(null);
  });

  test("unknown classification cannot reject an active callback field answer", async () => {
    const session = makeSession();
    VoiceUnderstandingService.classifyVoiceTurn.mockResolvedValue({ intent: "unknown", safety: { isEmergency: false }, entities: {} });
    VoiceCallbackService.isActive.mockReturnValue(true);
    await VoiceAgentService.handlePrompt({ session, customerMessage: "Adam Beahan" });
    await VoiceAgentService.handlePrompt({ session, customerMessage: "123 Peachtree Street" });
    expect(VoiceCallbackService.handle).toHaveBeenCalledTimes(2);
    expect(VoiceCallbackService.handle.mock.calls.every(([args]) => args.reason === undefined)).toBe(true);
  });

  test("unknown classification still permits repeating the previous question", async () => {
    const session = makeSession();
    session.transcript.push({ role: "assistant", text: "What is the service address?" });
    VoiceUnderstandingService.classifyVoiceTurn.mockResolvedValue({ intent: "unknown", safety: { isEmergency: false }, entities: {} });
    const result = await VoiceAgentService.handlePrompt({ session, customerMessage: "Could you repeat that?" });
    expect(result.reply).toContain("What is the service address?");
    expect(VoiceCallbackService.handle).not.toHaveBeenCalled();
  });

  test("unknown classification still routes an active booking slot answer", async () => {
    const session = makeSession();
    session.conversation.bookingState.status = "collecting_location";
    VoiceUnderstandingService.classifyVoiceTurn.mockResolvedValue({ intent: "unknown", safety: { isEmergency: false }, entities: {} });
    BookingStateMachineService.handle.mockResolvedValue({ handled: true, result: { reply: "What day works for you?" } });
    const result = await VoiceAgentService.handlePrompt({ session, customerMessage: "123 Peachtree Street" });
    expect(BookingStateMachineService.handle).toHaveBeenCalledWith(expect.objectContaining({ customerMessage: "123 Peachtree Street" }));
    expect(result.reply).toContain("What day works for you?");
  });

  test("genuinely unmatched turns have bounded recovery after contextual routing", async () => {
    const session = makeSession();
    VoiceUnderstandingService.classifyVoiceTurn.mockResolvedValue({ intent: "unknown", safety: { isEmergency: false }, entities: {} });
    const first = await VoiceAgentService.handlePrompt({ session, customerMessage: "Purple yesterday sideways" });
    expect(first.reply).toContain("What do you need help with?");
    expect(VoiceCallbackService.handle).not.toHaveBeenCalled();
    await VoiceAgentService.handlePrompt({ session, customerMessage: "Triangle of Thursday" });
    expect(VoiceCallbackService.handle).toHaveBeenCalledWith(expect.objectContaining({ reason: "low_ai_confidence" }));
  });

  test("does not quote a sole unrelated diagnostic offering", async () => {
    searchServicesTool.mockResolvedValue([{ id: "service-1", name: "Water heater", score: 0 }]);
    const result = await VoiceAgentService.handlePrompt({ session: makeSession(), customerMessage: "What is the bathtub diagnostic fee?" });
    expect(result.reply).toContain("don’t have a verified diagnostic fee");
    expect(ServiceOffering.findOne).not.toHaveBeenCalled();
  });

  test("quotes an explicitly approved diagnostic fee from one positive tenant match", async () => {
    searchServicesTool.mockResolvedValue([{ id: "service-1", name: "Bathtub inspection", score: 2 }]);
    ServiceOffering.findOne.mockResolvedValue({ name: "Bathtub inspection", aiCanDiscuss: true, discloseDiagnosticFee: true, diagnosticFee: 75 });
    const result = await VoiceAgentService.handlePrompt({ session: makeSession(), customerMessage: "What is the bathtub diagnostic fee?" });
    expect(result.reply).toContain("$75");
    expect(ServiceOffering.findOne).toHaveBeenCalledWith({ _id: "service-1", business: "business-1", active: true, aiCanDiscuss: true });
  });

  test.each([
    { aiCanDiscuss: false, discloseDiagnosticFee: true, diagnosticFee: 75 },
    { aiCanDiscuss: true, discloseDiagnosticFee: "true", diagnosticFee: 75 },
    { aiCanDiscuss: true, discloseDiagnosticFee: true, diagnosticFee: -10 },
    { aiCanDiscuss: true, discloseDiagnosticFee: true, diagnosticFee: "75" },
  ])("does not quote an unapproved or invalid diagnostic fee: %j", async fields => {
    searchServicesTool.mockResolvedValue([{ id: "service-1", score: 1 }]);
    ServiceOffering.findOne.mockResolvedValue({ name: "Bathtub inspection", ...fields });
    const result = await VoiceAgentService.handlePrompt({ session: makeSession(), customerMessage: "What is the bathtub diagnostic fee?" });
    expect(result.reply).toContain("don’t have a verified diagnostic fee");
  });

  test("does not quote an ambiguous diagnostic service match", async () => {
    searchServicesTool.mockResolvedValue([{ id: "service-1", score: 2 }, { id: "service-2", score: 1 }]);
    const result = await VoiceAgentService.handlePrompt({ session: makeSession(), customerMessage: "What is the bathtub diagnostic fee?" });
    expect(result.reply).toContain("don’t have a verified diagnostic fee");
    expect(ServiceOffering.findOne).not.toHaveBeenCalled();
  });

  test.each([false, true])("answers waitlist and emergency questions even during callback intake (%s)", async active => {
    const session = makeSession();
    session.lead.serviceNeeded = "Kitchen sink clog and dishwasher leak";
    session.lead.preferredAppointmentTime = "Wednesday at 9 AM";
    session.business.aiKnowledge = { verifiedFacts: { emergencyServiceAvailable: { verified: true, value: true } } };
    VoiceCallbackService.isActive.mockReturnValue(active);
    const waitlist = await VoiceAgentService.handlePrompt({ session, customerMessage: "Can I be added to a wait list?" });
    expect(waitlist.reply).toMatch(/can’t enroll.*waitlist/);
    const emergency = await VoiceAgentService.handlePrompt({ session, customerMessage: "Is there an emergency time?" });
    expect(emergency.reply).toMatch(/offers emergency service/);
    expect(emergency.reply).toMatch(/can’t confirm an emergency opening/);
    expect(emergency.reply).toMatch(/still leaking/);
    expect(session.lead.preferredAppointmentTime).toBe("Wednesday at 9 AM");
    expect(VoiceCallbackService.handle).not.toHaveBeenCalled();
    expect(BookingStateMachineService.handle).not.toHaveBeenCalled();
  });

  test("manual scheduling follow-up answers confirmation without starting callback capture", async () => {
    const session = makeSession();
    session.business.features.aiBookingEnabled = false;
    session.conversation.bookingState = { status: "human_takeover", lastError: "selected_slot_requires_manual_confirmation" };
    const result = await VoiceAgentService.handlePrompt({ session, customerMessage: "Will someone call to confirm?" });
    expect(result.reply).toMatch(/don't have a confirmation timeframe/);
    expect(VoiceCallbackService.handle).not.toHaveBeenCalled();
  });

  test("creates an urgent alert flow instead of blindly transferring safety calls", async () => {
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

    expect(result.reply).toMatch(/callback request/i);
    expect(session.lead.urgency).toBe("emergency");
    expect(VoiceCallbackService.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "safety_emergency:gas",
        alertType: "safety_emergency",
        priority: "critical",
        immediate: true,
        sendConfirmationSms: false,
      }),
    );
    expect(VoiceHandoffService.request).not.toHaveBeenCalled();
  });

  test("captures a callback when a caller asks for a human and live transfer is off", async () => {
    const session = makeSession();

    await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "Please transfer me to a person",
    });

    expect(VoiceCallbackService.handle).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "customer_requested_human" }),
    );
    expect(VoiceHandoffService.request).not.toHaveBeenCalled();
  });

  test("uses live transfer only for an explicit request when it is enabled", async () => {
    const session = makeSession();
    session.business.voiceSettings.liveTransferEnabled = true;

    const result = await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "I need to speak to an agent",
    });

    expect(result.reply).toMatch(/live-transfer line/i);
    expect(VoiceHandoffService.request).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "customer_requested_human" }),
    );
    expect(VoiceCallbackService.handle).not.toHaveBeenCalled();
  });

  test("captures a callback when the dedicated live-transfer window is closed", async () => {
    const session = makeSession();
    session.business.voiceSettings.liveTransferEnabled = true;
    VoiceAvailabilityService.isBusinessOpen.mockResolvedValue(false);

    await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "I need to speak to a person",
    });

    expect(VoiceHandoffService.request).not.toHaveBeenCalled();
    expect(VoiceCallbackService.handle).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "customer_requested_human" }),
    );
  });

  test("does not transfer or start booking for a greeting when booking is disabled", async () => {
    const session = makeSession();
    session.business.features.aiBookingEnabled = false;

    const result = await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "Hello",
    });

    expect(result.reply).toMatch(/callback request/i);
    expect(VoiceCallbackService.handle).not.toHaveBeenCalled();
    expect(BookingStateMachineService.handle).not.toHaveBeenCalled();
    expect(VoiceHandoffService.request).not.toHaveBeenCalled();
  });

  test("captures a concrete service request that cannot be matched", async () => {
    const session = makeSession();

    await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "My water heater is broken",
    });

    expect(VoiceCallbackService.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "service_not_matched",
        seedServiceFromMessage: true,
      }),
    );
    expect(VoiceHandoffService.request).not.toHaveBeenCalled();
  });

  test("captures booking details when automatic booking is disabled", async () => {
    const session = makeSession();
    session.business.features.aiBookingEnabled = false;

    await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "I need to schedule a plumbing appointment",
    });

    expect(VoiceCallbackService.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "voice_booking_not_enabled",
        seedServiceFromMessage: true,
      }),
    );
    expect(VoiceHandoffService.request).not.toHaveBeenCalled();
  });

  test("continues an active callback capture before starting another flow", async () => {
    const session = makeSession();
    VoiceCallbackService.isActive.mockReturnValue(true);

    await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "30303",
    });

    expect(VoiceCallbackService.handle).toHaveBeenCalledWith(
      expect.objectContaining({ customerMessage: "30303" }),
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

  test("marks a confirmed voice booking recovered", async () => {
    const session = makeSession();
    session.conversation.bookingState.status = "awaiting_confirmation";
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
    expect(session.lead).toMatchObject({
      status: "booked",
      recovered: true,
      recoveredBy: "voice_ai",
    });
  });

  test("captures a callback instead of transferring when provider booking fails", async () => {
    const session = makeSession();
    session.conversation.bookingState.status = "awaiting_confirmation";
    BookingStateMachineService.handle.mockImplementation(async () => {
      session.conversation.bookingState.status = "failed";
      return {
        handled: true,
        result: { reply: "I’m having trouble confirming that appointment." },
      };
    });

    await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "Yes",
    });

    expect(VoiceCallbackService.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "voice_booking_failed",
        alertType: "booking_conflict",
      }),
    );
    expect(VoiceHandoffService.request).not.toHaveBeenCalled();
  });
});


describe("CALLBACKIQ_DIFF_COVERAGE_VOICE_RELEASE", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    VoiceUnderstandingService
      .classifyVoiceTurn
      .mockResolvedValue({
        safety: {
          isEmergency: false,
          shouldSendSafetyReply: false,
        },
        entities: {
          urgency: "low",
        },
        intent: "other",
      });

    VoiceCallbackService.isActive
      .mockReturnValue(false);

    VoiceCallbackService.handle
      .mockResolvedValue({
        reply:
          "Your request was recorded.",
        callbackCaptured: true,
      });

    VoiceHandoffService.request
      .mockResolvedValue({
        type: "end",
        handoffData: "{}",
      });

    searchServicesTool.mockResolvedValue(
      [],
    );

    VoiceAvailabilityService.isBusinessOpen
      .mockResolvedValue(true);

    BookingStateMachineService.handle
      .mockResolvedValue({
        handled: true,
        result: {
          reply:
            "I can continue with the scheduling request.",
        },
      });
  });

  test(
    "preserves a higher deterministic operational urgency on the lead",
    async () => {
      const session = makeSession();

      session.lead.urgency = "low";

      const message = "This is urgent.";
      const CALLBACKIQ_SELECTED_URGENCY_FIXTURE = true;

      const expectedUrgency =
        classifyOperationalUrgency(message);

      expect(
        ["medium", "high", "emergency"],
      ).toContain(expectedUrgency);

      await VoiceAgentService.handlePrompt({
        session,
        customerMessage: message,
      });

      expect(
        session.lead.urgency,
      ).toBe(expectedUrgency);

      expect(
        session.lead.save,
      ).toHaveBeenCalled();
    },
  );

  test(
    "continues a read-only offered-slot flow even when AI booking is disabled",
    async () => {
      const session = makeSession();

      session.business.features.aiBookingEnabled =
        false;

      session.conversation.bookingState = {
        status: "offering_slots",
        appointment: null,
        offeredSlots: [
          {
            startAt:
              "2026-09-08T14:00:00.000Z",
            endAt:
              "2026-09-08T15:00:00.000Z",
          },
        ],
      };

      VoiceUnderstandingService
        .classifyVoiceTurn
        .mockResolvedValue({
          safety: {
            isEmergency: false,
            shouldSendSafetyReply: false,
          },
          entities: {},
          intent: "other",
        });

      await VoiceAgentService.handlePrompt({
        session,
        customerMessage: "option 1",
      });

      expect(
        BookingStateMachineService.handle,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          business: session.business,
          lead: session.lead,
          conversation:
            session.conversation,
          channel: "voice",
        }),
      );

      expect(
        VoiceCallbackService.handle,
      ).not.toHaveBeenCalledWith(
        expect.objectContaining({
          reason:
            "voice_booking_not_enabled",
        }),
      );
    },
  );
});
