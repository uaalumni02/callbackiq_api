import ServiceOffering from "../../src/models/serviceOffering.js";
import Conversation from "../../src/models/conversation.js";
import AppointmentService from "../../src/services/scheduling/appointment.service.js";
import AvailabilityService from "../../src/services/scheduling/availability.service.js";
import {
  getBookableService,
  getSchedulingPolicy,
  validateServiceArea,
} from "../../src/services/scheduling/appointmentPolicy.service.js";
import ConversionEventService from "../../src/services/conversionEvent.service.js";
import InterventionService from "../../src/services/intervention.service.js";
import { searchServicesTool } from "../../src/helpers/ai/tools/searchServices.tool.js";
import { getAvailabilityTool } from "../../src/helpers/ai/tools/getAvailability.tool.js";
import { validateServiceAreaTool } from "../../src/helpers/ai/tools/validateServiceArea.tool.js";
import { createAppointmentTool } from "../../src/helpers/ai/tools/createAppointment.tool.js";
import { cancelAppointmentTool } from "../../src/helpers/ai/tools/cancelAppointment.tool.js";
import { rescheduleAppointmentTool } from "../../src/helpers/ai/tools/rescheduleAppointment.tool.js";
import { escalateToHumanTool } from "../../src/helpers/ai/tools/escalateToHuman.tool.js";

jest.mock("../../src/models/serviceOffering.js", () => ({ __esModule: true, default: { find: jest.fn() } }));
jest.mock("../../src/models/conversation.js", () => ({ __esModule: true, default: { updateOne: jest.fn() } }));
jest.mock("../../src/services/scheduling/appointment.service.js", () => ({
  __esModule: true,
  default: { create: jest.fn(), cancel: jest.fn(), reschedule: jest.fn() },
}));
jest.mock("../../src/services/scheduling/availability.service.js", () => ({
  __esModule: true,
  default: { getAvailability: jest.fn() },
}));
jest.mock("../../src/services/scheduling/appointmentPolicy.service.js", () => ({
  __esModule: true,
  getBookableService: jest.fn(),
  getSchedulingPolicy: jest.fn(),
  validateServiceArea: jest.fn(),
}));
jest.mock("../../src/services/conversionEvent.service.js", () => ({
  __esModule: true,
  default: { record: jest.fn() },
}));
jest.mock("../../src/services/intervention.service.js", () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));

jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: {
    createSystemAlert: jest.fn(() => Promise.resolve({})),
  },
}));

const leanResult = (value) => ({ lean: jest.fn().mockResolvedValue(value) });

const appointmentPolicyMockForAiBookingToolsRelease =
  jest.requireMock(
    "../../src/services/scheduling/appointmentPolicy.service.js",
  );

appointmentPolicyMockForAiBookingToolsRelease.getAiBookableService =
  appointmentPolicyMockForAiBookingToolsRelease.getBookableService;

describe("AI booking tools", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    getSchedulingPolicy.mockResolvedValue({
      aiBookingConfirmationMode: "automatic",
      manualApprovalHoldMinutes: 30,
    });

    getBookableService.mockResolvedValue({
      _id: "s1",
      requiresHumanReview: false,
      aiCanBook: true,
    });
  });

  test("searches, scores, excludes, sorts, limits, and serializes services", async () => {
    const services = [
      { _id: 1, name: "Drain Cleaning", category: "Plumbing", keywords: ["clog"], excludedKeywords: ["roof"], durationMinutes: 60, estimatedValue: 200, requiresHumanReview: false },
      { _id: 2, name: "Leak Repair", category: "Plumbing", keywords: ["leak"], excludedKeywords: [], durationMinutes: 90, estimatedValue: 350, requiresHumanReview: true },
      { _id: 3, name: "Other", category: "General", keywords: [], excludedKeywords: [], durationMinutes: 30, estimatedValue: 100, requiresHumanReview: false },
    ];
    ServiceOffering.find.mockReturnValue(leanResult(services));
    const result = await searchServicesTool({ businessId: "b1", query: "I have a LEAK" });
    expect(result[0]).toMatchObject({ id: "2", name: "Leak Repair", score: 1 });
    expect(ServiceOffering.find).toHaveBeenCalledWith({ business: "b1", active: true, aiCanBook: true });
  });

  test("does not infer a service from an unrelated sole catalog entry or ambiguous catalog", async () => {
    ServiceOffering.find.mockReturnValueOnce(leanResult([{ _id: 1, name: "Only", keywords: [] }]));
    await expect(searchServicesTool({ businessId: "b1", query: "unknown" })).resolves.toHaveLength(0);
    ServiceOffering.find.mockReturnValueOnce(
      leanResult([{ _id: 1, name: "A", keywords: [] }, { _id: 2, name: "B", keywords: [] }]),
    );
    await expect(searchServicesTool({ businessId: "b1", query: "unknown" })).resolves.toEqual([]);
  });

  test("drops excluded services and limits results to five", async () => {
    const services = Array.from({ length: 7 }, (_, index) => ({
      _id: index,
      name: `Leak ${index}`,
      category: "leak",
      keywords: [],
      excludedKeywords: index === 0 ? ["emergency"] : [],
    }));
    ServiceOffering.find.mockReturnValue(leanResult(services));
    const result = await searchServicesTool({ businessId: "b1", query: "emergency leak" });
    expect(result).toHaveLength(5);
    expect(result.some((item) => item.id === "0")).toBe(false);
  });

  test("delegates availability and service-area validation", async () => {
    AvailabilityService.getAvailability.mockResolvedValue({ slots: [] });
    validateServiceArea.mockResolvedValue({ supported: true });
    await expect(getAvailabilityTool({ business: { _id: "b1" } })).resolves.toEqual({ slots: [] });
    await expect(validateServiceAreaTool({ businessId: "b1", postalCode: "30318" })).resolves.toEqual({ supported: true });
  });

  test("forces AI SMS metadata for create and reschedule", async () => {
    AppointmentService.create.mockResolvedValue({ _id: "a1" });
    AppointmentService.reschedule.mockResolvedValue({ _id: "a2" });
    const business = { _id: "b1" };
    await createAppointmentTool({
      business,
      input: { startAt: "date", serviceOfferingId: "s1" },
      idempotencyKey: "key",
    });

    expect(getSchedulingPolicy).toHaveBeenCalledWith("b1");
    expect(getBookableService).toHaveBeenCalledWith({
      businessId: "b1",
      serviceOfferingId: "s1",
    });

    expect(AppointmentService.create).toHaveBeenCalledWith({
      business,
      input: expect.objectContaining({
        startAt: "date",
        serviceOfferingId: "s1",
        source: "sms",
        bookedBy: "ai",
        requiresBusinessApproval: true,
        holdMinutes: 30,
      }),
      idempotencyKey: "key",
      confirm: false,
    });
    await rescheduleAppointmentTool({ business, appointmentId: "a1", input: { startAt: "next" }, idempotencyKey: "key2" });
    expect(AppointmentService.reschedule).toHaveBeenCalledWith({
      business,
      appointmentId: "a1",
      input: { startAt: "next", source: "sms", bookedBy: "ai" },
      idempotencyKey: "key2",
    });
  });

  test("delegates cancellation", async () => {
    AppointmentService.cancel.mockResolvedValue({ status: "canceled" });
    const business = { _id: "b1" };
    await cancelAppointmentTool({ business, appointmentId: "a1", reason: "customer" });
    expect(AppointmentService.cancel).toHaveBeenCalledWith({ business, appointmentId: "a1", reason: "customer" });
  });

  test("escalates booking to a human and records the event", async () => {
    Conversation.updateOne.mockResolvedValue({ acknowledged: true });
    ConversionEventService.record.mockResolvedValue({ _id: "event" });
    InterventionService.create.mockResolvedValue({ _id: "alert" });
    await expect(
      escalateToHumanTool({
        businessId: "b1",
        leadId: "l1",
        conversationId: "c1",
        reason: "customer_requested",
        customerMessage: "Call me",
      }),
    ).resolves.toEqual({ _id: "alert" });
    expect(Conversation.updateOne).toHaveBeenCalledWith(
      { _id: "c1", business: "b1" },
      { $set: expect.objectContaining({ humanTakeover: true, aiEnabled: false, "bookingState.status": "human_takeover" }) },
    );
    expect(ConversionEventService.record).toHaveBeenCalledWith(expect.objectContaining({ type: "human_takeover" }));
    expect(InterventionService.create).toHaveBeenCalledWith(expect.objectContaining({ type: "human_requested" }));
  });
});
