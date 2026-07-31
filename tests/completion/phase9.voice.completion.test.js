import Appointment from "../../src/models/appointment.js";
import createAppointmentTool from "../../src/helpers/ai/tools/createAppointment.tool.js";
import getAvailabilityTool from "../../src/helpers/ai/tools/getAvailability.tool.js";
import searchServicesTool from "../../src/helpers/ai/tools/searchServices.tool.js";
import sendConfirmationSmsTool from "../../src/helpers/ai/tools/sendConfirmationSms.tool.js";
import validateServiceAreaTool from "../../src/helpers/ai/tools/validateServiceArea.tool.js";
import { assessInboundSafety } from "../../src/services/safetyAssessmentService.js";
import VoiceAgentService from "../../src/voice/voiceAgent.service.js";
import Alert from "../../src/models/alert.js";
import {
  determineInitialVoiceRoute,
  determineVoiceFailureRoute,
  VOICE_ROUTE,
} from "../../src/voice/voiceRoutingPolicy.service.js";

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

jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

jest.mock("../../src/models/lead.js", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../src/helpers/ai/tools/searchServices.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/helpers/ai/tools/validateServiceArea.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/helpers/ai/tools/getAvailability.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/helpers/ai/tools/createAppointment.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/helpers/ai/tools/cancelAppointment.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/helpers/ai/tools/rescheduleAppointment.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/helpers/ai/tools/escalateToHuman.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/helpers/ai/tools/sendConfirmationSms.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/services/safetyAssessmentService.js", () => ({
  __esModule: true,
  assessInboundSafety: jest.fn(),
}));

jest.mock("../../src/services/automation/automationTrigger.service.js", () => ({
  __esModule: true,
  default: { schedule: jest.fn() },
}));

jest.mock("../../src/services/conversionEvent.service.js", () => ({
  __esModule: true,
  default: { record: jest.fn() },
}));

jest.mock("../../src/voice/voiceAvailability.service.js", () => ({
  __esModule: true,
  default: {
    describeBusinessHours: jest.fn(),
    isBusinessOpen: jest.fn().mockResolvedValue(true),
  },
}));

jest.mock("../../src/models/alert.js", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn() },
}));

jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitConversationUpdated: jest.fn(),
    emitAlertCreated: jest.fn(),
    emitDashboardRefresh: jest.fn(),
  },
}));

const setNested = (target, path, value) => {
  const parts = path.split(".");
  let cursor = target;

  for (const part of parts.slice(0, -1)) {
    cursor[part] = cursor[part] || {};
    cursor = cursor[part];
  }

  cursor[parts.at(-1)] = value;
};

const makeSession = () => {
  const lead = {
    _id: "lead-1",
    customerName: "Jordan Caller",
    phone: "+14045550100",
    email: "",
    serviceNeeded: "Unknown",
    address: "",
    urgency: "medium",
    status: "new",
    estimatedValue: 425,
    notes: "",
    save: jest.fn().mockResolvedValue(undefined),
  };
  const conversation = {
    _id: "conversation-1",
    humanTakeover: false,
    customerName: "Jordan Caller",
    customerPhone: "+14045550100",
    bookingState: { status: "not_started", appointment: null },
    set(path, value) {
      setNested(this, path, value);
    },
    save: jest.fn().mockResolvedValue(undefined),
    populate: jest.fn().mockResolvedValue(undefined),
  };
  const business = {
    _id: "business-1",
    businessName: "Peachtree Plumbing",
    timezone: "America/New_York",
    features: { aiBookingEnabled: true, voiceAiEnabled: true },
    voiceSettings: {
      liveTransferEnabled: false,
      liveTransferPhone: "+14045550199",
    },
  };

  return {
    _id: "voice-session-1",
    providerCallSid: "CA123",
    business,
    lead,
    conversation,
    transcript: [{ role: "customer", text: "I need service" }],
    callLog: null,
    save: jest.fn().mockResolvedValue(undefined),
  };
};

describe("Phase 9 completion gate using production voice orchestration", () => {
  const slot = {
    startAt: "2026-08-03T14:00:00.000Z",
    endAt: "2026-08-03T15:00:00.000Z",
  };
  const appointment = {
    _id: "appointment-1",
    status: "confirmed",
    startAt: slot.startAt,
    endAt: slot.endAt,
    timezone: "America/New_York",
    estimatedValue: 425,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    assessInboundSafety.mockResolvedValue({ isEmergency: false });
    searchServicesTool.mockResolvedValue([
      { id: "service-1", name: "Drain cleaning", score: 1 },
    ]);
    validateServiceAreaTool.mockResolvedValue({ supported: true });
    getAvailabilityTool.mockResolvedValue({ slots: [slot] });
    createAppointmentTool.mockResolvedValue(appointment);
    Appointment.findById.mockResolvedValue(appointment);
    sendConfirmationSmsTool.mockResolvedValue({ sent: true });
    Alert.findOneAndUpdate.mockResolvedValue({ _id: "alert-1" });
  });

  test("gate 1: selects ConversationRelay for an after-hours AI route", () => {
    const route = determineInitialVoiceRoute({
      isOpen: false,
      settings: {
        voiceAiEnabled: true,
        answerMode: "custom",
        transferPhone: "+14045550109",
        routingPolicy: {
          openHours: "staff_then_sms",
          afterHours: "voice_ai",
          voiceFailure: "sms",
        },
      },
    });

    expect(route).toBe(VOICE_ROUTE.RELAY);
  });

  test("gates 2-6: identifies service, validates area, offers real slots, books, and texts confirmation", async () => {
    const session = makeSession();

    const serviceReply = await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "I need drain cleaning",
    });

    expect(serviceReply.reply).toMatch(/drain cleaning/i);
    expect(searchServicesTool).toHaveBeenCalledWith({
      businessId: "business-1",
      query: "I need drain cleaning",
    });

    const areaReply = await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "123 Main Street, Atlanta GA 30303",
    });

    expect(areaReply.reply).toMatch(/what day works best/i);
    expect(validateServiceAreaTool).toHaveBeenCalledWith({
      businessId: "business-1",
      postalCode: "30303",
    });

    const slotsReply = await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "2026-08-03",
    });

    expect(slotsReply.reply).toMatch(/1\)/);
    expect(getAvailabilityTool).toHaveBeenCalledWith(
      expect.objectContaining({
        business: session.business,
        serviceOfferingId: "service-1",
        postalCode: "30303",
      }),
    );

    const selectionReply = await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "first",
    });

    expect(selectionReply.reply).toMatch(/say yes to confirm/i);

    const bookingReply = await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "yes",
    });

    expect(bookingReply.reply).toMatch(/booked/i);
    expect(createAppointmentTool).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ source: "voice" }),
      }),
    );
    expect(session.appointment).toBe("appointment-1");
    expect(session.lead.recoveredBy).toBe("voice_ai");
    expect(sendConfirmationSmsTool).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: "appointment-1",
        voiceSessionId: "voice-session-1",
      }),
    );
  });

  test("gate 7: transfers only when the caller explicitly asks and live transfer is enabled", async () => {
    const session = makeSession();
    session.business.voiceSettings.liveTransferEnabled = true;

    const result = await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "Please transfer me to a person",
    });

    expect(result.handoff).toEqual(expect.objectContaining({ type: "end" }));
    expect(session.status).toBe("transferring");
    expect(session.transferredToHuman).toBe(true);
    expect(session.transferReason).toBe("customer_requested_human");
    expect(Alert.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: "voice_handoff:voice-session-1:customer_requested_human",
      }),
      expect.any(Object),
      expect.objectContaining({ upsert: true }),
    );
    expect(searchServicesTool).not.toHaveBeenCalled();
  });

  test("gate 8: performs critical safety escalation before booking without a blind transfer", async () => {
    const session = makeSession();
    assessInboundSafety.mockResolvedValue({
      isEmergency: true,
      hazardType: "gas",
      reply: "Leave the area and call 911 now.",
    });

    const result = await VoiceAgentService.handlePrompt({
      session,
      customerMessage: "I smell gas and feel dizzy",
    });

    expect(result.reply).toMatch(/911/i);
    expect(result.handoff).toEqual(expect.objectContaining({ type: "end" }));
    expect(result.callbackCaptured).toBe(true);
    expect(session.lead.urgency).toBe("emergency");
    expect(session.status).not.toBe("transferring");
    expect(session.transferredToHuman).toBe(false);
    expect(session.transferReason).toBe(
      "callback_captured:safety_emergency:gas",
    );
    expect(Alert.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey:
          "voice_callback:voice-session-1:safety_emergency:gas",
      }),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          priority: "critical",
          type: "safety_emergency",
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(searchServicesTool).not.toHaveBeenCalled();
  });

  test("gate 9: selects SMS as the fail-safe after a voice session failure", () => {
    expect(
      determineVoiceFailureRoute({
        settings: {
          transferPhone: "+14045550109",
          routingPolicy: { voiceFailure: "sms" },
        },
      }),
    ).toBe(VOICE_ROUTE.FALLBACK_SMS);
  });
});
