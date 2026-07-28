import Appointment from "../../src/models/appointment.js";
import CallLog from "../../src/models/callLog.js";
import ConversionEvent from "../../src/models/conversionEvent.js";
import Lead from "../../src/models/lead.js";
import RevenueRecoveryService from "../../src/services/analytics/revenueRecovery.service.js";

jest.mock("../../src/models/appointment.js", () => ({
  __esModule: true,
  default: { aggregate: jest.fn() },
}));
jest.mock("../../src/models/callLog.js", () => ({
  __esModule: true,
  default: { countDocuments: jest.fn() },
}));
jest.mock("../../src/models/conversionEvent.js", () => ({
  __esModule: true,
  default: { aggregate: jest.fn(), countDocuments: jest.fn() },
}));
jest.mock("../../src/models/lead.js", () => ({
  __esModule: true,
  default: { countDocuments: jest.fn(), aggregate: jest.fn(), find: jest.fn() },
}));

describe("revenue recovery completion metrics", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns traceable recovery and human-intervention metrics", async () => {
    CallLog.countDocuments.mockResolvedValue(20);
    Lead.countDocuments
      .mockResolvedValueOnce(15)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(4);
    ConversionEvent.countDocuments.mockResolvedValue(3);
    Appointment.aggregate.mockResolvedValue([
      { count: 8, estimated: 6000, actual: 5000 },
    ]);
    Lead.aggregate.mockResolvedValue([
      { count: 7, estimated: 5200, actual: 4300 },
    ]);
    ConversionEvent.aggregate.mockResolvedValue([{ average: 18.4 }]);

    await expect(
      RevenueRecoveryService.summary({ businessId: "b1" }),
    ).resolves.toMatchObject({
      missedCalls: 20,
      customersReached: 15,
      qualifiedLeads: 10,
      appointmentsBooked: 8,
      recoveredLeads: 7,
      humanInterventions: 3,
      lostOpportunities: 4,
      responseRate: 0.75,
      qualificationRate: 10 / 15,
      bookingRate: 0.4,
      humanInterventionRate: 0.2,
      estimatedRecoveredRevenue: 5200,
      actualRecoveredRevenue: 4300,
      averageFirstResponseSeconds: 18,
    });
  });

  test("uses zero-safe rates", async () => {
    CallLog.countDocuments.mockResolvedValue(0);
    Lead.countDocuments.mockResolvedValue(0);
    ConversionEvent.countDocuments.mockResolvedValue(0);
    Appointment.aggregate.mockResolvedValue([]);
    Lead.aggregate.mockResolvedValue([]);
    ConversionEvent.aggregate.mockResolvedValue([]);

    await expect(
      RevenueRecoveryService.summary({ businessId: "b1" }),
    ).resolves.toMatchObject({
      responseRate: 0,
      qualificationRate: 0,
      bookingRate: 0,
      humanInterventionRate: 0,
    });
  });
});
