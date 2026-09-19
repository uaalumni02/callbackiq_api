// This suite isolates downstream orchestration. The actual catalog/tenant gate is
// exercised by serviceEligibility.journey.test.js and the configured channel journeys.
jest.mock('../../src/services/serviceEligibility/serviceEligibility.service.js', () => ({
  ...jest.requireActual('../../src/services/serviceEligibility/serviceEligibility.service.js'),
  guardServiceRequest: jest.fn().mockResolvedValue(null),
  assertServiceRequestEligible: jest.fn().mockResolvedValue({ decision: 'supported', canBook: true }),
}));
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
  default: { createSystemAlert: jest.fn(), create: jest.fn().mockResolvedValue({ alert: { _id: "alert1" } }) },
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

describe.each([
  ['collecting_location', '125 Main Street Atlanta GA 30318'],
  ['collecting_street_address', '125 Main Street Atlanta GA 30318'],
  ['collecting_postal_code', '30318'],
])('service-area decision during %s', (status, message) => {
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


  test.each([false, null, undefined])('blocks scheduling when coverage is %s', async supported => {
    validateServiceAreaTool.mockResolvedValue({ supported });
    const conversation = makeConversation({ bookingState: { status, streetAddress: '125 Main Street' } });
    const result = await handle({ conversation, message });
    expect(validateServiceAreaTool).toHaveBeenCalledWith({ businessId: 'b1', postalCode: '30318' });
    expect(escalateToHumanTool).toHaveBeenCalledTimes(1);
    expect(escalateToHumanTool).toHaveBeenCalledWith({
      businessId: 'b1', leadId: 'l1', conversationId: 'c1', customerMessage: message,
      reason: supported === false ? 'unsupported_service_area' : 'service_area_review_required',
    });
    expect(result.handled).toBe(true);
    expect(result.result.messageCategory).toBe('service_area_question');
    expect(result.result.reply).toMatch(/no appointment is confirmed/i);
    expect(result.result.reply).toMatch(supported === false ? /outside the configured service area/i : /couldn't verify coverage/i);
    expect(conversation.bookingState.status).toBe(status);
    expect(getAvailabilityTool).not.toHaveBeenCalled();
    expect(createAppointmentTool).not.toHaveBeenCalled();
  });

  test('verified coverage advances to preferences without escalation', async () => {
    const conversation = makeConversation({ bookingState: { status, streetAddress: '125 Main Street' } });
    const result = await handle({ conversation, message });
    expect(conversation.bookingState).toMatchObject({ status: 'collecting_preference', postalCode: '30318' });
    expect(result.result.reply).toMatch(/what day and time work best/i);
    expect(escalateToHumanTool).not.toHaveBeenCalled();
    expect(createAppointmentTool).not.toHaveBeenCalled();
  });
});
