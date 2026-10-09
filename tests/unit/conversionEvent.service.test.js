import CallLog from "../../src/models/callLog.js";
import ConversionEvent from "../../src/models/conversionEvent.js";
import Lead from "../../src/models/lead.js";
import SocketService from "../../src/services/socket.service.js";
import ConversionEventService from "../../src/services/conversionEvent.service.js";

jest.mock("../../src/models/callLog.js", () => ({ __esModule: true, default: { updateMany: jest.fn() } }));
jest.mock("../../src/models/conversionEvent.js", () => ({
  __esModule: true,
  default: { create: jest.fn(), findOne: jest.fn() },
}));
jest.mock("../../src/models/lead.js", () => ({ __esModule: true, default: { updateOne: jest.fn() } }));
jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: { emitToBusiness: jest.fn(), emitDashboardRefresh: jest.fn() },
}));

describe("ConversionEventService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => jest.clearAllMocks());

  test("records normalized values and emits real-time updates", async () => {
    const event = { _id: "event-1" };
    ConversionEvent.create.mockResolvedValue(event);
    await expect(
      ConversionEventService.record({
        businessId: "b1",
        leadId: "l1",
        conversationId: "c1",
        appointmentId: "a1",
        callLogId: "call1",
        type: "qualified",
        channel: "sms",
        source: "test",
        estimatedValue: "125.50",
        actualRevenue: null,
        idempotencyKey: "key",
        metadata: { score: 80 },
      }),
    ).resolves.toBe(event);
    expect(ConversionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedValue: 125.5, actualRevenue: 0 }),
    );
    expect(SocketService.emitToBusiness).toHaveBeenCalledWith(
      "b1",
      "conversion-event:created",
      event,
    );
    expect(SocketService.emitDashboardRefresh).toHaveBeenCalledWith("b1", "conversion:qualified");
  });

  test("returns the existing idempotent event after duplicate key", async () => {
    ConversionEvent.create.mockRejectedValue({ code: 11000 });
    ConversionEvent.findOne.mockResolvedValue({ _id: "existing" });
    await expect(
      ConversionEventService.record({ businessId: "b1", type: "qualified", idempotencyKey: "key" }),
    ).resolves.toEqual({ _id: "existing" });
    expect(ConversionEvent.findOne).toHaveBeenCalledWith({ business: "b1", idempotencyKey: "key" });
  });

  test("rethrows duplicates without idempotency and ordinary errors", async () => {
    ConversionEvent.create.mockRejectedValueOnce({ code: 11000 });
    await expect(
      ConversionEventService.record({ businessId: "b1", type: "qualified" }),
    ).rejects.toEqual({ code: 11000 });
    const error = new Error("database down");
    ConversionEvent.create.mockRejectedValueOnce(error);
    await expect(
      ConversionEventService.record({ businessId: "b1", type: "qualified", idempotencyKey: "key" }),
    ).rejects.toBe(error);
  });

  test.each([
    ["ai", "voice", "voice_ai"],
    ["ai", "sms", "sms_ai"],
    ["staff", "sms", "staff"],
    ["customer", "web", "manual"],
  ])("marks a recovered missed-call appointment booked by %s/%s", async (bookedBy, channel, recoveredBy) => {
    jest.spyOn(ConversionEventService, "record").mockResolvedValue({ _id: "event" });
    const appointment = {
      _id: "a1",
      business: "b1",
      lead: "l1",
      conversation: "c1",
      confirmedAt: new Date("2026-07-27T12:00:00Z"),
      estimatedValue: 500,
      actualRevenue: 450,
      provider: "internal",
    };
    const lead = { _id: "l1", source: "missed_call" };
    await expect(
      ConversionEventService.markAppointmentBooked({ appointment, lead, channel, bookedBy }),
    ).resolves.toEqual({ _id: "event" });
    expect(Lead.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "l1", business: "b1", $or: expect.any(Array) }),
      { $set: expect.objectContaining({ status: "booked", recovered: true, recoveredBy }) },
    );
    expect(CallLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ business: "b1", lead: "l1" }),
      { $set: { recovered: true } },
    );
    expect(ConversionEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({ source: "missed_call_recovery", metadata: expect.objectContaining({ recoveredBy }) }),
    );
  });

  test("handles a direct booking and missing lead", async () => {
    jest.spyOn(ConversionEventService, "record").mockResolvedValue({ _id: "event" });
    const appointment = {
      _id: "a1",
      business: "b1",
      lead: null,
      conversation: "c1",
      estimatedValue: 100,
      actualRevenue: 0,
      provider: "google_calendar",
    };
    await ConversionEventService.markAppointmentBooked({
      appointment,
      lead: null,
      channel: "web",
      bookedBy: "customer",
    });
    expect(Lead.updateOne).not.toHaveBeenCalled();
    expect(CallLog.updateMany).not.toHaveBeenCalled();
    expect(ConversionEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({ source: "direct_booking", metadata: expect.objectContaining({ recovered: false, recoveredBy: null }) }),
    );
  });
});
