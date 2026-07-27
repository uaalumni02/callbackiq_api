import Appointment from "../../src/models/appointment.js";
import CallLog from "../../src/models/callLog.js";
import ConversionEvent from "../../src/models/conversionEvent.js";
import Lead from "../../src/models/lead.js";
import RevenueRecoveryService from "../../src/services/analytics/revenueRecovery.service.js";

jest.mock("../../src/models/appointment.js", () => ({ __esModule: true, default: { aggregate: jest.fn() } }));
jest.mock("../../src/models/callLog.js", () => ({ __esModule: true, default: { countDocuments: jest.fn() } }));
jest.mock("../../src/models/conversionEvent.js", () => ({ __esModule: true, default: { aggregate: jest.fn() } }));
jest.mock("../../src/models/lead.js", () => ({
  __esModule: true,
  default: { countDocuments: jest.fn(), aggregate: jest.fn(), find: jest.fn() },
}));

const findChain = (value) => {
  const chain = {
    sort: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    lean: jest.fn().mockResolvedValue(value),
  };
  return chain;
};

describe("RevenueRecoveryService", () => {
  beforeEach(() => jest.clearAllMocks());

  test("calculates a traceable summary and rates", async () => {
    CallLog.countDocuments.mockResolvedValue(10);
    Lead.countDocuments.mockResolvedValueOnce(8).mockResolvedValueOnce(4);
    Appointment.aggregate.mockResolvedValue([{ count: 3, estimated: 1800, actual: 1500 }]);
    Lead.aggregate.mockResolvedValue([{ count: 2, estimated: 1200, actual: 900 }]);
    ConversionEvent.aggregate.mockResolvedValue([{ average: 17.6 }]);
    const result = await RevenueRecoveryService.summary({
      businessId: "b1",
      startDate: "2026-07-01T00:00:00.000Z",
      endDate: "2026-07-31T23:59:59.999Z",
    });
    expect(result).toMatchObject({
      missedCalls: 10,
      customersReached: 8,
      qualifiedLeads: 4,
      appointmentsBooked: 3,
      recoveredLeads: 2,
      responseRate: 0.8,
      qualificationRate: 0.5,
      bookingRate: 0.3,
      estimatedRecoveredRevenue: 1200,
      actualRecoveredRevenue: 900,
      estimatedBookedRevenue: 1800,
      actualBookedRevenue: 1500,
      averageFirstResponseSeconds: 18,
    });
  });

  test("uses default dates and zero-safe summaries", async () => {
    CallLog.countDocuments.mockResolvedValue(0);
    Lead.countDocuments.mockResolvedValue(0);
    Appointment.aggregate.mockResolvedValue([]);
    Lead.aggregate.mockResolvedValue([]);
    ConversionEvent.aggregate.mockResolvedValue([]);
    const result = await RevenueRecoveryService.summary({ businessId: "b1" });
    expect(result).toMatchObject({
      responseRate: 0,
      qualificationRate: 0,
      bookingRate: 0,
      appointmentsBooked: 0,
      recoveredLeads: 0,
      averageFirstResponseSeconds: 0,
    });
    expect(new Date(result.endDate).getTime()).toBeGreaterThan(new Date(result.startDate).getTime());
  });

  test("returns trends and source pipelines", async () => {
    ConversionEvent.aggregate.mockResolvedValue([{ _id: { date: "2026-07-27" } }]);
    Lead.aggregate.mockResolvedValue([{ _id: "missed_call" }]);
    await expect(RevenueRecoveryService.trends({ businessId: "b1" })).resolves.toHaveLength(1);
    await expect(RevenueRecoveryService.sources({ businessId: "b1" })).resolves.toHaveLength(1);
    expect(ConversionEvent.aggregate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ $sort: { "_id.date": 1 } })]));
    expect(Lead.aggregate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ $sort: { leads: -1 } })]));
  });

  test.each([
    [undefined, 100],
    ["not-a-number", 100],
    [500, 250],
    [25, 25],
  ])("caps lost-opportunity limit %s to %s", async (limit, expected) => {
    const chain = findChain([{ _id: "lead" }]);
    Lead.find.mockReturnValue(chain);
    await expect(RevenueRecoveryService.lostOpportunities({ businessId: "b1", limit })).resolves.toHaveLength(1);
    expect(chain.limit).toHaveBeenCalledWith(expected);
  });

  test("builds a funnel from the summary", async () => {
    jest.spyOn(RevenueRecoveryService, "summary").mockResolvedValue({
      missedCalls: 10,
      customersReached: 8,
      qualifiedLeads: 4,
      appointmentsBooked: 3,
      recoveredLeads: 2,
    });
    await expect(RevenueRecoveryService.funnel({ businessId: "b1" })).resolves.toEqual([
      { stage: "Missed inquiries", count: 10 },
      { stage: "Customers reached", count: 8 },
      { stage: "Qualified leads", count: 4 },
      { stage: "Appointments booked", count: 3 },
      { stage: "Recovered leads", count: 2 },
    ]);
  });
});
