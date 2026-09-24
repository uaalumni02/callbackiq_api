jest.mock('../../src/models/serviceOffering.js', () => ({ __esModule: true, default: { find: jest.fn() } }));
import EligibilityCatalog from '../../src/models/serviceOffering.js';
import EligibilityOperations from '../../src/models/businessOperationsSettings.js';
import { approvedOffering, catalogQuery } from '../helpers/approvedServiceCatalog.js';
jest.mock('../../src/models/businessOperationsSettings.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
beforeEach(() => {
  EligibilityCatalog.find = jest.fn(() => catalogQuery([approvedOffering('service-1', 'plumbing', [])]));
  EligibilityOperations.findOne.mockReturnValue(catalogQuery({ serviceEligibilityPolicy: { catalogComplete: true } }));
});
import BookingStateMachineService from "../../src/services/booking/bookingStateMachine.service.js";
import searchServicesTool from "../../src/helpers/ai/tools/searchServices.tool.js";

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
    humanTakeover: false,
    bookingState: { status: "not_started" },
  };
  conversation.set = jest.fn((field, value) => {
    conversation.bookingState[field.replace("bookingState.", "")] = value;
  });
  conversation.save = jest.fn().mockResolvedValue(conversation);
  return conversation;
};

const makeLead = () => ({
  _id: "lead-1",
  serviceNeeded: "Unknown",
  save: jest.fn().mockResolvedValue(undefined),
});

const business = {
  _id: "business-1",
  timezone: "America/New_York",
  features: { aiBookingEnabled: true },
};

describe("voice channel booking-state reuse", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    searchServicesTool.mockResolvedValue([
      { id: "service-1", name: "Drain clearing" },
    ]);
  });

  test("ordinary voice service statements enter the shared booking flow", async () => {
    const conversation = makeConversation();
    const lead = makeLead();

    const result = await BookingStateMachineService.handle({
      business,
      lead,
      conversation,
      customerMessage: "My sink is clogged",
      channel: "voice",
      source: "voice_booking_state_machine",
    });

    expect(result.handled).toBe(true);
    expect(searchServicesTool).toHaveBeenCalledWith({
      businessId: "business-1",
      query: "My sink is clogged",
    });
    expect(conversation.bookingState.status).toBe("collecting_location");
    expect(result.result.reply).toMatch(/address.*ZIP code/i);
  });

  test("the same statement does not change the existing SMS intent trigger", async () => {
    const result = await BookingStateMachineService.handle({
      business,
      lead: makeLead(),
      conversation: makeConversation(),
      customerMessage: "My sink is clogged",
      channel: "sms",
    });

    expect(result).toEqual({ handled: false });
    expect(searchServicesTool).not.toHaveBeenCalled();
  });
});
