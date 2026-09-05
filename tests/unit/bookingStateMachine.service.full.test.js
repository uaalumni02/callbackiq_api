import Appointment from "../../src/models/appointment.js";
import Conversation from "../../src/models/conversation.js";
import ServiceOffering from "../../src/models/serviceOffering.js";
import AutomationTriggerService from "../../src/services/automation/automationTrigger.service.js";
import BookingStateMachineService from "../../src/services/booking/bookingStateMachine.service.js";
import ConversionEventService from "../../src/services/conversionEvent.service.js";
import AlertService from "../../src/services/alert.service.js";
import { buildBusinessReadiness } from "../../src/services/businessReadiness.service.js";
import cancelAppointmentTool from "../../src/helpers/ai/tools/cancelAppointment.tool.js";
import createAppointmentTool from "../../src/helpers/ai/tools/createAppointment.tool.js";
import escalateToHumanTool from "../../src/helpers/ai/tools/escalateToHuman.tool.js";
import getAvailabilityTool from "../../src/helpers/ai/tools/getAvailability.tool.js";
import rescheduleAppointmentTool from "../../src/helpers/ai/tools/rescheduleAppointment.tool.js";
import searchServicesTool from "../../src/helpers/ai/tools/searchServices.tool.js";
import validateServiceAreaTool from "../../src/helpers/ai/tools/validateServiceArea.tool.js";

jest.mock("../../src/models/appointment.js", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn(), updateOne: jest.fn() },
}));
jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
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
jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: { createSystemAlert: jest.fn() },
}));
jest.mock("../../src/services/businessReadiness.service.js", () => ({
  __esModule: true,
  buildBusinessReadiness: jest.fn(),
  default: { buildBusinessReadiness: jest.fn() },
}));
jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  __esModule: true,
  logOperationalError: jest.fn(),
  logOperationalEvent: jest.fn(),
}));
jest.mock("../../src/services/scheduling/timezone.service.js", () => ({
  __esModule: true,
  formatDateKey: jest.fn((value) => new Date(value).toISOString().slice(0, 10)),
}));
jest.mock("../../src/helpers/ai/tools/cancelAppointment.tool.js", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../src/helpers/ai/tools/createAppointment.tool.js", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../src/helpers/ai/tools/escalateToHuman.tool.js", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../src/helpers/ai/tools/getAvailability.tool.js", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../src/helpers/ai/tools/rescheduleAppointment.tool.js", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../src/helpers/ai/tools/searchServices.tool.js", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../src/helpers/ai/tools/validateServiceArea.tool.js", () => ({ __esModule: true, default: jest.fn() }));

const SLOT_1 = {
  startAt: "2026-07-28T13:00:00.000Z",
  endAt: "2026-07-28T14:00:00.000Z",
};
const SLOT_2 = {
  startAt: "2026-07-28T15:00:00.000Z",
  endAt: "2026-07-28T16:00:00.000Z",
};
const SLOT_3 = {
  startAt: "2026-07-28T17:00:00.000Z",
  endAt: "2026-07-28T18:00:00.000Z",
};

const makeConversation = (overrides = {}) => {
  const {
    bookingState: bookingStateOverrides = {},
    ...conversationOverrides
  } = overrides;

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
      ...bookingStateOverrides,
    },
    ...conversationOverrides,
  };
  conversation.set = jest.fn((path, value) => {
    const key = path.replace("bookingState.", "");
    conversation.bookingState[key] = value;
  });
  conversation.save = jest.fn().mockResolvedValue(conversation);
  return conversation;
};

const makeLead = (overrides = {}) => ({
  _id: "l1",
  customerName: "Jane",
  phone: "+14045550100",
  email: "jane@example.com",
  serviceNeeded: "Unknown",
  address: "",
  estimatedValue: 250,
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

const business = {
  _id: "b1",
  timezone: "America/New_York",
  features: { aiBookingEnabled: true },
};

const handle = ({ conversation = makeConversation(), lead = makeLead(), message = "book appointment", customBusiness = business } = {}) =>
  BookingStateMachineService.handle({
    business: customBusiness,
    lead,
    conversation,
    customerMessage: message,
  });

describe("BookingStateMachineService complete behavior", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildBusinessReadiness.mockResolvedValue({
      states: { bookingReady: true },
      missingRequirements: { booking: [] },
    });
    AlertService.createSystemAlert.mockResolvedValue({});
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
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    searchServicesTool.mockResolvedValue([{ id: "s1", name: "HVAC diagnostic" }]);
    validateServiceAreaTool.mockResolvedValue({ supported: true });
    getAvailabilityTool.mockResolvedValue({ slots: [SLOT_1, SLOT_2, SLOT_3] });
    createAppointmentTool.mockResolvedValue({
      _id: "a1",
      status: "held",
      requiresBusinessApproval: true,
      approvalRequestedAt: new Date(),
      startAt: SLOT_1.startAt,
      endAt: SLOT_1.endAt,
      timezone: "America/New_York",
    });
    rescheduleAppointmentTool.mockResolvedValue({
      _id: "a2",
      status: "confirmed",
      startAt: SLOT_1.startAt,
      endAt: SLOT_1.endAt,
      timezone: "America/New_York",
    });
    cancelAppointmentTool.mockResolvedValue({ status: "canceled" });
    Appointment.findOneAndUpdate.mockResolvedValue({
      _id: "a1",
      status: "confirmed",
      startAt: SLOT_1.startAt,
      endAt: SLOT_1.endAt,
      timezone: "America/New_York",
    });
    Appointment.updateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("findConversation uses an explicit conversation", async () => {
    const conversation = makeConversation();
    await expect(BookingStateMachineService.findConversation({ business, lead: makeLead(), conversation })).resolves.toBe(conversation);
    expect(Conversation.findOne).not.toHaveBeenCalled();
  });

  test("findConversation returns null without a lead", async () => {
    await expect(BookingStateMachineService.findConversation({ business, lead: null })).resolves.toBeNull();
  });

  test("findConversation retrieves the latest open lead conversation", async () => {
    const conversation = makeConversation();
    const sort = jest.fn().mockResolvedValue(conversation);
    Conversation.findOne.mockReturnValue({ sort });
    await expect(BookingStateMachineService.findConversation({ business, lead: makeLead() })).resolves.toBe(conversation);
    expect(Conversation.findOne).toHaveBeenCalledWith({ business: "b1", lead: "l1", status: "open" });
    expect(sort).toHaveBeenCalledWith({ lastMessageAt: -1 });
  });

  test("does nothing when AI booking is disabled", async () => {
    await expect(handle({ customBusiness: { ...business, features: { aiBookingEnabled: false } } })).resolves.toEqual({ handled: false });
  });

  test("queries real business availability for an availability inquiry even when auto-booking is disabled", async () => {
    const customBusiness = {
      ...business,
      businessName: "Atlanta Pro Plumbing & Drain",
      features: { aiBookingEnabled: false },
    };
    const lead = makeLead({ serviceNeeded: "sink is clogged" });
    searchServicesTool.mockResolvedValueOnce([
      { id: "s1", name: "Drain cleaning" },
    ]);

    const result = await handle({
      customBusiness,
      lead,
      message: "What is you availability this week?",
    });

    expect(searchServicesTool).toHaveBeenCalledWith({
      businessId: "b1",
      query: "sink is clogged",
    });
    expect(getAvailabilityTool).toHaveBeenCalledWith(
      expect.objectContaining({
        business: customBusiness,
        serviceOfferingId: "s1",
      }),
    );
    expect(result.handled).toBe(true);
    expect(result.result.messageCategory).toBe("availability_inquiry");
    expect(result.result.preferredAppointmentTime).toBe("");
    expect(result.result.reply).toMatch(/current openings/i);
    expect(result.result.reply).toMatch(/not a confirmed appointment/i);
    expect(result.result.reply).not.toMatch(/I've noted/i);
  });

  test("never invents availability when the calendar provider cannot be queried", async () => {
    const customBusiness = {
      ...business,
      businessName: "Atlanta Pro Plumbing & Drain",
      features: { aiBookingEnabled: false },
    };
    const lead = makeLead({ serviceNeeded: "sink is clogged" });
    searchServicesTool.mockResolvedValueOnce([
      { id: "s1", name: "Drain cleaning" },
    ]);
    getAvailabilityTool.mockRejectedValueOnce(new Error("provider unavailable"));

    const result = await handle({
      customBusiness,
      lead,
      message: "What is your availability this week?",
    });

    expect(result.handled).toBe(true);
    expect(result.result.messageCategory).toBe("availability_inquiry");
    expect(result.result.preferredAppointmentTime).toBe("");
    expect(result.result.reply).toMatch(/can’t verify live availability right now/i);
  });

  test("does nothing without a conversation or during human takeover", async () => {
    await expect(handle({ conversation: null, lead: null })).resolves.toEqual({ handled: false });
    await expect(handle({ conversation: makeConversation({ humanTakeover: true }) })).resolves.toEqual({ handled: false });
  });

  test("ignores ordinary text before booking starts", async () => {
    await expect(handle({ message: "hello there" })).resolves.toEqual({ handled: false });
  });

  test("escalates explicit human requests during an active booking flow", async () => {
    const conversation = makeConversation({
      bookingState: { status: "collecting_service" },
    });
    const result = await handle({ conversation, lead: null, message: "I need to talk to a person" });
    expect(escalateToHumanTool).toHaveBeenCalledWith({
      businessId: "b1",
      leadId: undefined,
      conversationId: "c1",
      reason: "customer_requested_human",
      customerMessage: "I need to talk to a person",
    });
    expect(result.result.messageCategory).toBe("human_requested");
  });

  test("answers exact-pricing requests during an active booking flow without invoking AI tools", async () => {
    const conversation = makeConversation({
      bookingState: { status: "collecting_service" },
    });
    const result = await handle({ conversation, message: "What is the exact total cost?" });
    expect(result.result.messageCategory).toBe("pricing_request");
    expect(searchServicesTool).not.toHaveBeenCalled();
  });

  test.each(["failed", "collecting_service"])("resets stale state and asks for a service from %s", async (status) => {
    const conversation = makeConversation({
      bookingState: {
        status,
        expiresAt: status === "failed" ? null : new Date("2026-07-27T11:59:00Z"),
        offeredSlots: [SLOT_1],
        selectedSlot: SLOT_1,
        lastError: "old error",
      },
    });
    searchServicesTool.mockResolvedValue([]);
    const result = await handle({ conversation, message: "book" });
    expect(conversation.bookingState).toMatchObject({
      status: "collecting_service",
      offeredSlots: [],
      selectedSlot: null,
      expiresAt: null,
      lastError: "",
    });
    expect(result.result.reply).toContain("What service");
  });

  test("lists ambiguous matching services", async () => {
    searchServicesTool.mockResolvedValue([
      { id: "s1", name: "Repair" },
      { id: "s2", name: "Replacement" },
    ]);
    const result = await handle();
    expect(result.result.reply).toContain("Repair, Replacement");
  });

  test("selects one service and updates an unknown lead service", async () => {
    const conversation = makeConversation();
    const lead = makeLead();
    const result = await handle({ conversation, lead });
    expect(conversation.bookingState).toMatchObject({ status: "collecting_location", serviceOffering: "s1" });
    expect(lead.serviceNeeded).toBe("HVAC diagnostic");
    expect(lead.save).toHaveBeenCalled();
    expect(result.result.reply).toContain("address and ZIP code");
  });

  test("does not replace an existing lead service", async () => {
    const lead = makeLead({ serviceNeeded: "Drain repair" });
    await handle({ lead });
    expect(lead.serviceNeeded).toBe("Drain repair");
    expect(lead.save).not.toHaveBeenCalled();
  });

  test("collecting location requires a ZIP", async () => {
    const result = await handle({
      conversation: makeConversation({
        bookingState: {
          status: "collecting_location",
          postalCode: null,
        },
      }),
      message: "123 Main Street",
    });
    expect(result.result.reply).toContain("5-digit ZIP");
    expect(validateServiceAreaTool).not.toHaveBeenCalled();
  });

  test("rejects text that does not look like a navigable street address", async () => {
    const conversation = makeConversation({
      bookingState: { status: "collecting_location", postalCode: "30318" },
    });
    const lead = makeLead();
    const result = await handle({ conversation, lead, message: "Main" });
    expect(validateServiceAreaTool).not.toHaveBeenCalled();
    expect(lead.save).not.toHaveBeenCalled();
    expect(result.result.reply).toMatch(/street number and street name/i);
  });

  test("collecting street address reuses a ZIP captured in the prior message", async () => {
    const conversation = makeConversation({
      bookingState: { status: "collecting_street_address", postalCode: "30318" },
    });
    const lead = makeLead();
    const result = await handle({
      conversation,
      lead,
      message: "125 Main Street",
    });
    expect(validateServiceAreaTool).toHaveBeenCalledWith({
      businessId: "b1",
      postalCode: "30318",
    });
    expect(lead.address).toBe("125 Main Street");
    expect(conversation.bookingState.status).toBe("collecting_preference");
    expect(result.result.reply).toMatch(/what day and time work best/i);
  });

  test("unsupported ZIP escalates to staff", async () => {
    validateServiceAreaTool.mockResolvedValue({ supported: false });
    const result = await handle({
      conversation: makeConversation({ bookingState: { status: "collecting_location" } }),
      message: "123 Main Street 99999",
    });
    expect(escalateToHumanTool).toHaveBeenCalledWith(expect.objectContaining({ reason: "unsupported_service_area" }));
    expect(result.result.messageCategory).toBe("service_area_question");
  });

  test("supported location saves address and advances", async () => {
    const conversation = makeConversation({ bookingState: { status: "collecting_location" } });
    const lead = makeLead();
    const result = await handle({ conversation, lead, message: "123 Main Street Atlanta GA 30318" });
    expect(lead.address).toContain("123 Main");
    expect(lead.save).toHaveBeenCalled();
    expect(conversation.bookingState).toMatchObject({ status: "collecting_preference", postalCode: "30318" });
    expect(result.result.reply).toContain("What day and time work best");
  });

  test("collecting preference rejects an unrecognized date", async () => {
    const result = await handle({
      conversation: makeConversation({ bookingState: { status: "collecting_preference" } }),
      message: "whenever",
    });
    expect(result.result.reply).toContain("Please send the day and time");
  });

  test.each([
    ["2026-08-03", "2026-08-03", "2026-08-03"],
    ["2026-08-03 through 2026-08-05", "2026-08-03", "2026-08-05"],
    ["today", "2026-07-27", "2026-07-27"],
    ["tomorrow", "2026-07-28", "2026-07-28"],
    ["Tuesday", "2026-07-28", "2026-07-28"],
    ["Monday", "2026-08-03", "2026-08-03"],
    ["next week", "2026-08-03", "2026-08-09"],
  ])("offers slots for date expression %s", async (message, startDate, endDate) => {
    const conversation = makeConversation({ bookingState: { status: "collecting_preference" } });
    const result = await handle({ conversation, message });
    expect(getAvailabilityTool).toHaveBeenCalledWith(expect.objectContaining({ startDate, endDate }));
    expect(conversation.bookingState.status).toBe("offering_slots");
    expect(conversation.bookingState.offeredSlots).toHaveLength(3);
    expect(ConversionEventService.record).toHaveBeenCalledWith(expect.objectContaining({ type: "appointment_offered" }));
    expect(AutomationTriggerService.schedule).toHaveBeenCalledWith(expect.objectContaining({ trigger: "appointment_offered_not_selected" }));
    expect(result.result.reply).toContain("1)");
  });

  test("asks for another window when no slots exist", async () => {
    getAvailabilityTool.mockResolvedValue({ slots: [] });
    const result = await handle({
      conversation: makeConversation({ bookingState: { status: "collecting_preference" } }),
      message: "tomorrow",
    });
    expect(result.result.reply).toMatch(/day or time/i);
    expect(ConversionEventService.record).not.toHaveBeenCalled();
  });

  test.each([
    ["first", SLOT_1],
    ["option 2", SLOT_2],
    ["three", SLOT_3],
  ])("selects offered slot using %s", async (message, expected) => {
    const conversation = makeConversation({
      bookingState: { status: "offering_slots", offeredSlots: [SLOT_1, SLOT_2, SLOT_3] },
    });
    const result = await handle({ conversation, message });
    expect(new Date(conversation.bookingState.selectedSlot.startAt).toISOString()).toBe(expected.startAt);
    expect(conversation.bookingState.status).toBe("awaiting_confirmation");
    expect(result.result.reply).toContain("Reply YES");
  });

  test("selects a slot using a stored label", async () => {
    const labeled = { ...SLOT_1, label: "Tuesday special" };
    const conversation = makeConversation({ bookingState: { status: "offering_slots", offeredSlots: [labeled] } });
    await handle({ conversation, message: "Tuesday special works" });
    expect(conversation.bookingState.selectedSlot).toEqual(labeled);
  });

  test("selects a slot using its local time", async () => {
    const conversation = makeConversation({ bookingState: { status: "offering_slots", offeredSlots: [SLOT_1] } });
    await handle({ conversation, message: "9:00 am works" });
    expect(conversation.bookingState.selectedSlot).toEqual(SLOT_1);
  });

  test("re-runs availability when a new date is sent while offering slots", async () => {
    const conversation = makeConversation({ bookingState: { status: "offering_slots", offeredSlots: [SLOT_1] } });
    const result = await handle({ conversation, message: "2026-08-03" });
    expect(getAvailabilityTool).toHaveBeenCalled();
    expect(result.result.reply).toContain("Which option");
  });

  test("asks for an option number when no offered slot matches", async () => {
    const result = await handle({
      conversation: makeConversation({ bookingState: { status: "offering_slots", offeredSlots: [SLOT_1] } }),
      message: "late afternoon please",
    });
    expect(result.result.reply).toContain("option number");
  });

  test("negative confirmation returns to preference collection", async () => {
    const conversation = makeConversation({ bookingState: { status: "awaiting_confirmation", selectedSlot: SLOT_1 } });
    const result = await handle({ conversation, message: "no" });
    expect(conversation.bookingState).toMatchObject({ status: "collecting_preference", selectedSlot: null, offeredSlots: [], expiresAt: null });
    expect(result.result.reply).toContain("other day");
  });

  test("ambiguous confirmation asks for YES or NO", async () => {
    const result = await handle({
      conversation: makeConversation({ bookingState: { status: "awaiting_confirmation", selectedSlot: SLOT_1 } }),
      message: "maybe",
    });
    expect(result.result.reply).toContain("reply YES");
  });

  test("affirmative confirmation submits an appointment for business approval", async () => {
    const conversation = makeConversation({ bookingState: { status: "awaiting_confirmation", selectedSlot: SLOT_1 } });
    const lead = makeLead({ serviceNeeded: "HVAC diagnostic", address: "123 Main" });
    const result = await handle({ conversation, lead, message: "yes" });
    expect(createAppointmentTool).toHaveBeenCalledWith(expect.objectContaining({
      business,
      idempotencyKey: expect.stringContaining("ai-book:c1"),
      input: expect.objectContaining({
        lead: "l1",
        conversation: "c1",
        customerName: "Jane",
        address: expect.objectContaining({ street: "123 Main", postalCode: "30318" }),
      }),
    }));
    expect(conversation.bookingState).toMatchObject({
      status: "pending_business_confirmation",
      appointment: "a1",
      lastError: "",
    });
    expect(result.result.reply).toMatch(/pending business approval/i);
    expect(result.result.reply).toMatch(/not confirmed/i);
  });

  test("uses conversation customer fallbacks without a lead", async () => {
    const conversation = makeConversation({ bookingState: { status: "awaiting_confirmation", selectedSlot: SLOT_1 } });
    await handle({ conversation, lead: null, message: "okay" });
    expect(createAppointmentTool).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ customerName: "Jane", customerPhone: "+14045550100", estimatedValue: 0 }),
    }));
  });

  test("submits a reschedule for business approval without replacing the confirmed appointment", async () => {
    const conversation = makeConversation({
      bookingState: {
        status: "awaiting_confirmation",
        selectedSlot: SLOT_1,
        appointment: "old-a1",
        lastError: "reschedule_requested",
      },
    });
    const result = await handle({ conversation, message: "confirm" });

    expect(AlertService.createSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Appointment reschedule approval required",
        metadata: expect.objectContaining({
          appointmentId: "old-a1",
        }),
      }),
    );
    expect(rescheduleAppointmentTool).not.toHaveBeenCalled();
    expect(createAppointmentTool).not.toHaveBeenCalled();
    expect(conversation.bookingState).toMatchObject({
      status: "booked",
      appointment: "old-a1",
      lastError: "reschedule_pending_business_approval",
    });
    expect(result.result.reply).toMatch(/existing appointment remains confirmed/i);
  });

  test("fails safely when an AI appointment bypasses the required approval contract", async () => {
    createAppointmentTool.mockResolvedValue({
      _id: "a1",
      status: "held",
      requiresBusinessApproval: false,
    });
    const conversation = makeConversation({ bookingState: { status: "awaiting_confirmation", selectedSlot: SLOT_1 } });
    const result = await handle({ conversation, message: "yes" });

    expect(conversation.bookingState.status).toBe("failed");
    expect(conversation.bookingState.lastError).toMatch(/business-approval hold/i);
    expect(result.result.reply).toMatch(/team|confirm/i);
  });

  test("uses a provider-safe customer error message", async () => {
    const error = new Error("provider failed");
    error.safeCustomerMessage = "Please wait for the team.";
    createAppointmentTool.mockRejectedValue(error);
    const result = await handle({
      conversation: makeConversation({ bookingState: { status: "awaiting_confirmation", selectedSlot: SLOT_1 } }),
      message: "yes",
    });
    expect(result.result.reply).toBe("Please wait for the team.");
  });

  test("cancels a booked appointment", async () => {
    const conversation = makeConversation({ bookingState: { status: "booked", appointment: "a1", offeredSlots: [SLOT_1], selectedSlot: SLOT_1 } });
    const result = await handle({ conversation, message: "cancel my appointment" });
    expect(cancelAppointmentTool).toHaveBeenCalledWith({ business, appointmentId: "a1", reason: "Customer requested cancellation by SMS." });
    expect(conversation.bookingState).toMatchObject({ status: "not_started", appointment: null, selectedSlot: null, offeredSlots: [] });
    expect(result.result.reply).toContain("has been canceled");
  });

  test("returns a safe message when cancellation fails", async () => {
    cancelAppointmentTool.mockRejectedValue(new Error("down"));
    const result = await handle({
      conversation: makeConversation({ bookingState: { status: "booked", appointment: "a1" } }),
      message: "cancel",
    });
    expect(result.result.reply).toContain("couldn’t confirm the cancellation");
  });

  test("starts a booked-appointment reschedule", async () => {
    const conversation = makeConversation({ bookingState: { status: "booked", appointment: "a1" } });
    const result = await handle({ conversation, message: "change the appointment" });
    expect(conversation.bookingState).toMatchObject({ status: "collecting_preference", lastError: "reschedule_requested" });
    expect(result.result.reply).toContain("new day");
  });

  test("accepts conversational yes text and submits for business approval", async () => {
    const conversation = makeConversation({
      bookingState: { status: "awaiting_confirmation", selectedSlot: SLOT_1 },
    });
    const result = await handle({ conversation, message: "Yes please, that works for me" });
    expect(createAppointmentTool).toHaveBeenCalled();
    expect(conversation.bookingState.status).toBe("pending_business_confirmation");
    expect(result.result.reply).toMatch(/pending business approval/i);
    expect(result.result.reply).toMatch(/not confirmed/i);
  });

  test("understands weekday abbreviations and tomorrow variants", async () => {
    const tuesday = makeConversation({
      bookingState: { status: "collecting_preference" },
    });
    await handle({ conversation: tuesday, message: "Tues" });
    expect(getAvailabilityTool).toHaveBeenLastCalledWith(
      expect.objectContaining({ startDate: "2026-07-28" }),
    );

    const tomorrow = makeConversation({
      bookingState: { status: "collecting_preference" },
    });
    await handle({ conversation: tomorrow, message: "tmrw" });
    expect(getAvailabilityTool).toHaveBeenLastCalledWith(
      expect.objectContaining({ startDate: "2026-07-28" }),
    );
  });

  test("filters afternoon requests before offering slots", async () => {
    const conversation = makeConversation({
      bookingState: { status: "collecting_preference" },
    });
    await handle({ conversation, message: "Tues afternoon" });
    expect(conversation.bookingState.timeOfDay).toBe("afternoon");
    expect(conversation.bookingState.offeredSlots).toHaveLength(1);
    expect(
      new Date(conversation.bookingState.offeredSlots[0].startAt).toISOString(),
    ).toBe(SLOT_3.startAt);
  });

  test("records C confirmation and R reschedule replies", async () => {
    const confirmedConversation = makeConversation({
      bookingState: { status: "booked", appointment: "a1" },
    });
    const confirmed = await handle({
      conversation: confirmedConversation,
      message: "C",
    });
    expect(Appointment.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "a1", business: "b1" }),
      expect.objectContaining({ $set: { customerConfirmedAt: expect.any(Date) } }),
      { new: true },
    );
    expect(confirmed.result.reply).toContain("is confirmed");

    const rescheduleConversation = makeConversation({
      bookingState: { status: "booked", appointment: "a1" },
    });
    const reschedule = await handle({
      conversation: rescheduleConversation,
      message: "R",
    });
    expect(Appointment.updateOne).toHaveBeenCalledWith(
      { _id: "a1", business: "b1" },
      { $set: { customerRescheduleRequestedAt: expect.any(Date) } },
    );
    expect(rescheduleConversation.bookingState.status).toBe(
      "collecting_preference",
    );
    expect(reschedule.result.reply).toContain("day and time");
  });

  test("reschedule intent takes precedence over a casual affirmative", async () => {
    const conversation = makeConversation({
      bookingState: { status: "booked", appointment: "a1" },
    });
    const result = await handle({
      conversation,
      message: "Sure, but I need to reschedule",
    });
    expect(Appointment.updateOne).toHaveBeenCalled();
    expect(Appointment.findOneAndUpdate).not.toHaveBeenCalled();
    expect(result.result.reply).toMatch(/new day and time/i);
  });

  test("returns unhandled for ordinary booked and unknown states", async () => {
    await expect(handle({ conversation: makeConversation({ bookingState: { status: "booked" } }), message: "thanks" })).resolves.toEqual({ handled: false });
    await expect(handle({ conversation: makeConversation({ bookingState: { status: "mystery" } }), message: "book" })).resolves.toEqual({ handled: false });
  });
});


describe("Booking production readiness/provider regressions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-04T22:00:00.000Z"));
    buildBusinessReadiness.mockResolvedValue({
      states: { bookingReady: true },
      missingRequirements: { booking: [] },
    });
    AlertService.createSystemAlert.mockResolvedValue({});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("blocks automatic booking when runtime readiness is incomplete", async () => {
    buildBusinessReadiness.mockResolvedValue({
      states: { bookingReady: false },
      missingRequirements: {
        booking: [
          {
            code: "availability_required",
            message: "Configure availability before booking.",
          },
        ],
      },
    });

    const result = await handle({
      conversation: makeConversation({
        bookingState: { status: "collecting_preference" },
      }),
      message: "tomorrow",
    });

    expect(result.handled).toBe(true);
    expect(result.result.messageCategory).toBe("human_requested");
    expect(result.result.reply).toMatch(/alerted the team/i);
    expect(getAvailabilityTool).not.toHaveBeenCalled();
    expect(AlertService.createSystemAlert).toHaveBeenCalled();
  });

  test("provider failure is a handoff, not a no-slots response", async () => {
    const providerError = Object.assign(new Error("calendar offline"), {
      code: "GOOGLE_RECONNECT_REQUIRED",
    });
    getAvailabilityTool.mockRejectedValue(providerError);

    const result = await handle({
      conversation: makeConversation({
        bookingState: { status: "collecting_preference" },
      }),
      message: "tomorrow",
    });

    expect(result.result.messageCategory).toBe("human_requested");
    expect(result.result.reply).toMatch(/trouble checking the live schedule/i);
    expect(result.result.reply).not.toMatch(/don.?t see an available/i);
    expect(AlertService.createSystemAlert).toHaveBeenCalled();
  });

  test("expanded provider failure is not swallowed as zero availability", async () => {
    getAvailabilityTool
      .mockResolvedValueOnce({ slots: [] })
      .mockRejectedValueOnce(
        Object.assign(new Error("calendar token expired"), {
          code: "GOOGLE_RECONNECT_REQUIRED",
        }),
      );

    const result = await handle({
      conversation: makeConversation({
        bookingState: { status: "collecting_preference" },
      }),
      message: "tomorrow",
    });

    expect(getAvailabilityTool).toHaveBeenCalledTimes(2);
    expect(result.result.messageCategory).toBe("human_requested");
    expect(result.result.reply).toMatch(/trouble checking the live schedule/i);
    expect(AlertService.createSystemAlert).toHaveBeenCalled();
  });

  test("true zero slots remains a zero-slots outcome without provider alert", async () => {
    getAvailabilityTool.mockResolvedValue({ slots: [] });

    const result = await handle({
      conversation: makeConversation({
        bookingState: { status: "collecting_preference" },
      }),
      message: "tomorrow",
    });

    expect(result.result.reply).toMatch(/don.?t see an available/i);
    expect(AlertService.createSystemAlert).not.toHaveBeenCalled();
  });
});
