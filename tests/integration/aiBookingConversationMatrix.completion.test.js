import Appointment from "../../src/models/appointment.js";
import Conversation from "../../src/models/conversation.js";
import ServiceOffering from "../../src/models/serviceOffering.js";
import AutomationTriggerService from "../../src/services/automation/automationTrigger.service.js";
import BookingStateMachineService from "../../src/services/booking/bookingStateMachine.service.js";
import ConversionEventService from "../../src/services/conversionEvent.service.js";
import cancelAppointmentTool from "../../src/helpers/ai/tools/cancelAppointment.tool.js";
import createAppointmentTool from "../../src/helpers/ai/tools/createAppointment.tool.js";
import escalateToHumanTool from "../../src/helpers/ai/tools/escalateToHuman.tool.js";
import getAvailabilityTool from "../../src/helpers/ai/tools/getAvailability.tool.js";
import rescheduleAppointmentTool from "../../src/helpers/ai/tools/rescheduleAppointment.tool.js";
import searchServicesTool from "../../src/helpers/ai/tools/searchServices.tool.js";
import validateServiceAreaTool from "../../src/helpers/ai/tools/validateServiceArea.tool.js";

jest.mock("../../src/services/businessReadiness.service.js", () => ({
  __esModule: true,
  buildBusinessReadiness: jest.fn().mockResolvedValue({
    states: {
      bookingReady: true,
      bookingConfigurationReady: true,
    },
    missingRequirements: {
      booking: [],
    },
  }),
}));

jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));
jest.mock("../../src/models/appointment.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    updateOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  },
}));
jest.mock("../../src/models/serviceOffering.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));
jest.mock("../../src/models/lead.js", () => ({ __esModule: true, default: {} }));
jest.mock("../../src/services/automation/automationTrigger.service.js", () => ({
  __esModule: true,
  default: { schedule: jest.fn() },
}));
jest.mock("../../src/services/conversionEvent.service.js", () => ({
  __esModule: true,
  default: { record: jest.fn() },
}));
jest.mock("../../src/services/scheduling/timezone.service.js", () => ({
  __esModule: true,
  formatDateKey: jest.fn((value) => new Date(value).toISOString().slice(0, 10)),
}));
jest.mock("../../src/helpers/ai/tools/cancelAppointment.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("../../src/helpers/ai/tools/createAppointment.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("../../src/helpers/ai/tools/escalateToHuman.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("../../src/helpers/ai/tools/getAvailability.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("../../src/helpers/ai/tools/rescheduleAppointment.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("../../src/helpers/ai/tools/searchServices.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("../../src/helpers/ai/tools/validateServiceArea.tool.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const SLOT = {
  startAt: "2026-07-28T13:00:00.000Z",
  endAt: "2026-07-28T14:00:00.000Z",
};

const SLOT_2 = {
  startAt: "2026-07-28T15:00:00.000Z",
  endAt: "2026-07-28T16:00:00.000Z",
};

const business = {
  _id: "b1",
  timezone: "America/New_York",
  features: { aiBookingEnabled: true },
};

const makeConversation = (bookingState = {}) => {
  const conversation = {
    _id: "c1",
    customerName: "Jane",
    customerPhone: "+14045550100",
    humanTakeover: false,
    bookingState: {
      status: "not_started",
      serviceOffering: "s1",
      postalCode: "30318",
      offeredSlots: [],
      selectedSlot: null,
      appointment: null,
      expiresAt: null,
      lastError: "",
      ...bookingState,
    },
  };
  conversation.set = jest.fn((path, value) => {
    conversation.bookingState[path.replace("bookingState.", "")] = value;
  });
  conversation.save = jest.fn().mockResolvedValue(conversation);
  return conversation;
};

const lead = {
  _id: "l1",
  customerName: "Jane",
  phone: "+14045550100",
  email: "jane@example.com",
  serviceNeeded: "HVAC diagnostic",
  address: "123 Main Street",
  estimatedValue: 350,
  save: jest.fn(),
};

const handle = (conversation, customerMessage) =>
  BookingStateMachineService.handle({
    business,
    lead,
    conversation,
    customerMessage,
  });

describe("AI booking required conversation matrix", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ServiceOffering.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: "s1",
        business: "b1",
        name: "HVAC diagnostic",
        estimatedValue: 350,
        diagnosticFee: 89,
        discloseDiagnosticFee: true,
      }),
    });
    jest.useFakeTimers().setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    Conversation.findOne.mockResolvedValue(null);
    searchServicesTool.mockResolvedValue([{ id: "s1", name: "HVAC diagnostic" }]);
    validateServiceAreaTool.mockResolvedValue({ supported: true });
    getAvailabilityTool.mockResolvedValue({ slots: [SLOT] });
    const heldAppointment = {
      _id: "a1",
      status: "held",
      requiresBusinessApproval: true,
      startAt: SLOT.startAt,
      endAt: SLOT.endAt,
      timezone: "America/New_York",
      heldExpiresAt: new Date("2026-07-27T12:30:00.000Z"),
    };
    createAppointmentTool.mockResolvedValue(heldAppointment);
    Appointment.findOne.mockResolvedValue(heldAppointment);
    Appointment.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("a repeated YES cannot create a second appointment", async () => {
    const conversation = makeConversation({
      status: "awaiting_confirmation",
      selectedSlot: SLOT,
    });

    const first = await handle(conversation, "yes");
    const second = await handle(conversation, "yes");

    expect(first.handled).toBe(true);
    expect(conversation.bookingState).toMatchObject({
      status: "pending_business_confirmation",
      appointment: "a1",
    });
    expect(second.handled).toBe(true);
    expect(second.result.reply).toMatch(/awaiting business approval/i);
    expect(createAppointmentTool).toHaveBeenCalledTimes(1);
    expect(createAppointmentTool).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("ai-book:c1"),
      }),
    );
  });

  test("an expired offered-slot state is cleared before any selection", async () => {
    const conversation = makeConversation({
      status: "offering_slots",
      offeredSlots: [SLOT],
      selectedSlot: SLOT,
      expiresAt: new Date("2026-07-27T11:59:00.000Z"),
    });

    const result = await handle(conversation, "first");

    expect(conversation.bookingState).toMatchObject({
      status: "collecting_service",
      offeredSlots: [],
      selectedSlot: null,
      expiresAt: null,
    });
    expect(createAppointmentTool).not.toHaveBeenCalled();
    expect(result.result.reply).toContain("What service");
  });

  test("an unsupported ZIP escalates without offering appointment slots", async () => {
    validateServiceAreaTool.mockResolvedValue({ supported: false });
    const conversation = makeConversation({ status: "collecting_location" });

    const result = await handle(
      conversation,
      "123 Main Street Atlanta GA 99999",
    );

    expect(escalateToHumanTool).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "unsupported_service_area" }),
    );
    expect(getAvailabilityTool).not.toHaveBeenCalled();
    expect(result.result.messageCategory).toBe("service_area_question");
  });

  test("selecting two offered slots requires clarification and books neither", async () => {
    const conversation = makeConversation({
      status: "offering_slots",
      offeredSlots: [SLOT, SLOT_2],
    });

    const result = await handle(conversation, "1 and 2 both work");

    expect(conversation.bookingState.status).toBe("offering_slots");
    expect(conversation.bookingState.selectedSlot).toBeNull();
    expect(createAppointmentTool).not.toHaveBeenCalled();
    expect(result.result.reply).toContain("option number");
  });

  test("a Google/provider failure never claims the appointment was booked", async () => {
    const providerError = new Error("Google Calendar unavailable");
    providerError.safeCustomerMessage =
      "I could not confirm that time. A team member will follow up.";
    createAppointmentTool.mockRejectedValue(providerError);
    const conversation = makeConversation({
      status: "awaiting_confirmation",
      selectedSlot: SLOT,
    });

    const result = await handle(conversation, "yes");

    expect(conversation.bookingState.status).toBe("failed");
    expect(conversation.bookingState.appointment).toBeNull();
    expect(result.result.reply).toBe(providerError.safeCustomerMessage);
  });

  test("exact-price questions do not execute booking tools", async () => {
    const conversation = makeConversation({ status: "collecting_service" });

    const result = await handle(
      conversation,
      "What is the exact final price including everything?",
    );

    expect(result.result.messageCategory).toBe("pricing_request");
    expect(searchServicesTool).not.toHaveBeenCalled();
    expect(createAppointmentTool).not.toHaveBeenCalled();
  });
});
