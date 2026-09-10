import BookingStateMachineService from "../../src/services/booking/bookingStateMachine.service.js";
import getAvailabilityTool from "../../src/helpers/ai/tools/getAvailability.tool.js";
import createAppointmentTool from "../../src/helpers/ai/tools/createAppointment.tool.js";

jest.mock("../../src/services/businessReadiness.service.js", () => ({
  __esModule: true,
  buildBusinessReadiness: jest.fn().mockResolvedValue({
    states: { bookingReady: true, bookingConfigurationReady: true },
    missingRequirements: { booking: [] },
  }),
}));

jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));
jest.mock("../../src/models/lead.js", () => ({ __esModule: true, default: {} }));
jest.mock("../../src/models/appointment.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), updateOne: jest.fn(), findOneAndUpdate: jest.fn() },
}));
jest.mock("../../src/models/serviceOffering.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));
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

const makeConversation = () => {
  const conversation = {
    _id: "conversation-1",
    customerPhone: "+14045550100",
    customerName: "Customer",
    humanTakeover: false,
    bookingState: {
      status: "collecting_preference",
      serviceOffering: "service-1",
      streetAddress: "125 Main Street",
      postalCode: "30303",
      availabilityInquiry: true,
      offeredSlots: [],
    },
  };
  conversation.set = jest.fn((field, value) => {
    conversation.bookingState[field.replace("bookingState.", "")] = value;
  });
  conversation.save = jest.fn().mockResolvedValue(conversation);
  return conversation;
};

describe("production scheduling regression: exact urgent availability journey", () => {
  const business = {
    _id: "business-1",
    businessName: "Service Business",
    timezone: "America/New_York",
    features: { aiBookingEnabled: true },
  };

  afterEach(() => jest.useRealTimers());
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-05T12:00:00Z"));
    jest.clearAllMocks();
    getAvailabilityTool.mockResolvedValue({
      supportedServiceArea: true,
      slots: [
        { startAt: "2026-09-09T13:00:00.000Z", endAt: "2026-09-09T14:30:00.000Z" },
        { startAt: "2026-09-07T15:00:00.000Z", endAt: "2026-09-07T16:30:00.000Z" },
        { startAt: "2026-09-08T14:00:00.000Z", endAt: "2026-09-08T15:30:00.000Z" },
        { startAt: "2026-09-07T14:00:00.000Z", endAt: "2026-09-07T15:30:00.000Z" },
      ],
    });
  });

  test("high urgency + 'when could someone come out?' offers the earliest three real slots and stores no fake preference", async () => {
    const conversation = makeConversation();
    const lead = {
      _id: "lead-1",
      customerName: "Customer",
      phone: "+14045550100",
      serviceNeeded: "Drain clearing",
      urgency: "high",
      preferredAppointmentTime: "",
      save: jest.fn(),
    };

    const result = await BookingStateMachineService.handle({
      business,
      lead,
      conversation,
      customerMessage: "when could someone come out?",
      channel: "sms",
    });

    expect(result.handled).toBe(true);
    expect(conversation.bookingState.status).toBe("offering_slots");
    expect(conversation.bookingState.offeredSlots).toHaveLength(3);

    const starts = conversation.bookingState.offeredSlots.map((slot) =>
      new Date(slot.startAt).getTime(),
    );
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Date(conversation.bookingState.offeredSlots[0].startAt).toISOString())
      .toBe("2026-09-07T14:00:00.000Z");
    expect(lead.preferredAppointmentTime).toBe("");
    expect(result.result.reply).toMatch(/1\).*2\).*3\)/s);
    expect(result.result.reply).not.toMatch(/not a confirmed appointment/i);
  });

  test("price + availability returns safe pricing context and real slots", async () => {
    const conversation = makeConversation();
    const lead = {
      _id: "lead-1",
      customerName: "Customer",
      phone: "+14045550100",
      serviceNeeded: "Drain clearing",
      urgency: "high",
      preferredAppointmentTime: "",
      save: jest.fn(),
    };

    const result = await BookingStateMachineService.handle({
      business,
      lead,
      conversation,
      customerMessage: "How much is it and when could someone come out?",
      channel: "sms",
    });

    expect(result.handled).toBe(true);
    expect(conversation.bookingState.status).toBe("offering_slots");
    expect(result.result.reply).toMatch(/price range|estimate|pricing|cost/i);
    expect(result.result.reply).toMatch(/1\).*2\).*3\)/s);
    expect(lead.preferredAppointmentTime).toBe("");
  });

  test("only after the customer selects a slot does CallBackIQ explain approval", async () => {
    const conversation = makeConversation();
    conversation.bookingState.status = "offering_slots";
    conversation.bookingState.offeredSlots = [
      { startAt: new Date("2026-09-07T14:00:00.000Z"), endAt: new Date("2026-09-07T15:30:00.000Z"), timezone: "America/New_York", label: "Monday, Sep 7, 10:00 AM" },
      { startAt: new Date("2026-09-07T15:00:00.000Z"), endAt: new Date("2026-09-07T16:30:00.000Z"), timezone: "America/New_York", label: "Monday, Sep 7, 11:00 AM" },
    ];
    const lead = {
      _id: "lead-1",
      customerName: "Customer",
      phone: "+14045550100",
      serviceNeeded: "Drain clearing",
      urgency: "high",
      save: jest.fn(),
    };

    const result = await BookingStateMachineService.handle({
      business,
      lead,
      conversation,
      customerMessage: "first one",
      channel: "voice",
    });

    expect(conversation.bookingState.status).toBe("awaiting_confirmation");
    expect(result.result.reply).toMatch(/appointment request/i);
    expect(result.result.reply).toMatch(/business approval|not confirmed/i);
  });

  test("YES creates a held request pending business approval, never a direct AI confirmation", async () => {
    const conversation = makeConversation();
    conversation.bookingState.status = "awaiting_confirmation";
    conversation.bookingState.selectedSlot = {
      startAt: new Date("2026-09-07T14:00:00.000Z"),
      endAt: new Date("2026-09-07T15:30:00.000Z"),
      timezone: "America/New_York",
      label: "Monday, Sep 7, 10:00 AM",
    };
    const lead = {
      _id: "lead-1",
      customerName: "Customer",
      phone: "+14045550100",
      serviceNeeded: "Drain clearing",
      urgency: "high",
      save: jest.fn(),
    };
    createAppointmentTool.mockResolvedValue({
      _id: "appointment-1",
      status: "held",
      requiresBusinessApproval: true,
      heldExpiresAt: new Date("2026-09-05T17:00:00.000Z"),
      startAt: new Date("2026-09-07T14:00:00.000Z"),
      endAt: new Date("2026-09-07T15:30:00.000Z"),
      timezone: "America/New_York",
    });

    const result = await BookingStateMachineService.handle({
      business,
      lead,
      conversation,
      customerMessage: "yes",
      channel: "voice",
      source: "voice_booking_state_machine",
    });

    expect(conversation.bookingState.status).toBe("pending_business_confirmation");
    expect(result.result.reply).toMatch(/pending business approval/i);
    expect(result.result.reply).not.toMatch(/you're booked/i);
  });
});

describe.each(['sms', 'voice'])('reported read-only journey (%s)', (channel) => {
  beforeEach(() => { jest.useFakeTimers().setSystemTime(new Date('2026-09-06T10:00:00Z')); });
  afterEach(() => jest.useRealTimers());
  const business = { _id: 'business-1', businessName: 'Atlanta Pro Plumbing', timezone: 'America/New_York', features: { aiBookingEnabled: false } };
  const offered = () => {
    const c = makeConversation();
    Object.assign(c.bookingState, { status: 'offering_slots', expiresAt: new Date('2026-09-07T15:45:00Z'), offeredSlots: [
      { startAt: new Date('2026-09-07T17:00:00Z'), endAt: new Date('2026-09-07T17:30:00Z') },
      { startAt: new Date('2026-09-07T17:30:00Z'), endAt: new Date('2026-09-07T18:00:00Z') },
      { startAt: new Date('2026-09-07T18:00:00Z'), endAt: new Date('2026-09-07T18:30:00Z') },
    ] });
    return c;
  };
  test('natural time selects the matching slot, persists review and answers confirmation without restarting', async () => {
    const conversation = offered();
    const lead = { _id: 'lead-1', save: jest.fn() };
    const result = await BookingStateMachineService.handle({ business, lead, conversation, channel, customerMessage: 'Tomorrow at 1:30pm' });
    expect(result.result.reply).toMatch(/1:30 PM/);
    expect(conversation.bookingState.selectedSlot.startAt.toISOString()).toBe('2026-09-07T17:30:00.000Z');
    expect(conversation.bookingState.status).toBe('human_takeover');
    expect(conversation.bookingState.expiresAt).toBeNull();
    expect(conversation.bookingState.offeredSlots).toEqual([]);
    const followup = await BookingStateMachineService.handle({ business, lead, conversation, channel, customerMessage: 'Will someone call to confirm?' });
    expect(followup.result.reply).toMatch(/can't guarantee a confirmation call/);
    expect(followup.result.reply).not.toMatch(/choose|option numbers/);
    expect(conversation.bookingState.status).toBe('human_takeover');
  });
  test.each(['Today at 1:30pm', '1 or 2', '1:45pm'])('does not silently select an unsupported time: %s', async customerMessage => {
    const conversation = offered();
    await BookingStateMachineService.handle({ business, conversation, channel, customerMessage });
    expect(conversation.bookingState.selectedSlot).toBeUndefined();
    expect(conversation.bookingState.status).toBe('offering_slots');
  });
  test('confirmation question is not consent to submit', async () => {
    const conversation = offered();
    conversation.bookingState.status = 'awaiting_confirmation';
    createAppointmentTool.mockClear();
    const result = await BookingStateMachineService.handle({ business: { ...business, features: { aiBookingEnabled: true } }, conversation, channel, customerMessage: 'Can you confirm it?' });
    expect(result.result.reply).toMatch(/not been submitted/);
    expect(createAppointmentTool).not.toHaveBeenCalled();
  });
});
