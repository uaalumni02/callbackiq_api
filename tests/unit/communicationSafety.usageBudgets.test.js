jest.mock("../../src/models/communicationUsage.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: {
    createSystemAlert: jest.fn(),
  },
}));

jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  __esModule: true,
  logOperationalEvent: jest.fn(),
  logOperationalWarning: jest.fn(),
  logOperationalError: jest.fn(),
}));

import CommunicationUsage from "../../src/models/communicationUsage.js";
import AlertService from "../../src/services/alert.service.js";
import {
  reserveAiUsage,
  reserveSmsUsage,
} from "../../src/services/communicationUsage.service.js";

describe("business and customer communication budgets", () => {
  const business = {
    _id: "64f000000000000000000001",
    communicationLimits: {
      smsBusinessHourly: 100,
      smsBusinessDaily: 1000,
      smsCustomerHourly: 10,
      smsCustomerDaily: 100,
      aiBusinessHourly: 100,
      aiBusinessDaily: 1000,
      aiCustomerHourly: 10,
      aiCustomerDaily: 100,
      alertThresholdPercent: 80,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    CommunicationUsage.updateOne.mockResolvedValue({ acknowledged: true });
    AlertService.createSystemAlert.mockResolvedValue({ _id: "alert-1" });
  });

  test("reserves hourly and daily counters for both business and customer", async () => {
    CommunicationUsage.findOneAndUpdate
      .mockResolvedValueOnce({ _id: "1", count: 1 })
      .mockResolvedValueOnce({ _id: "2", count: 1 })
      .mockResolvedValueOnce({ _id: "3", count: 1 })
      .mockResolvedValueOnce({ _id: "4", count: 1 });

    const result = await reserveSmsUsage({
      business,
      customerPhone: "+1 (404) 555-0101",
      now: new Date("2026-07-30T18:15:00.000Z"),
    });

    expect(result.allowed).toBe(true);
    expect(CommunicationUsage.findOneAndUpdate).toHaveBeenCalledTimes(4);
    expect(
      CommunicationUsage.findOneAndUpdate.mock.calls.map(([filter]) =>
        filter.scope,
      ),
    ).toEqual(["business", "business", "customer", "customer"]);
  });

  test("rolls back earlier reservations when a later customer limit is reached", async () => {
    CommunicationUsage.findOneAndUpdate
      .mockResolvedValueOnce({ _id: "1", count: 1 })
      .mockResolvedValueOnce({ _id: "2", count: 1 })
      .mockResolvedValueOnce(null);

    const result = await reserveAiUsage({
      business,
      customerPhone: "+14045550101",
      now: new Date("2026-07-30T18:15:00.000Z"),
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: "customer_hour_ai_operation_limit",
      scope: "customer",
      window: "hour",
    });
    expect(CommunicationUsage.updateOne).toHaveBeenCalledTimes(2);
    expect(AlertService.createSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: business._id,
        priority: "high",
        metadata: expect.objectContaining({
          metric: "ai_operation",
          scope: "customer",
          percentage: 100,
        }),
      }),
    );
  });

  test("emits a deduplicated warning at the configured threshold", async () => {
    CommunicationUsage.findOneAndUpdate
      .mockResolvedValueOnce({ _id: "1", count: 80 })
      .mockResolvedValueOnce({ _id: "2", count: 1 })
      .mockResolvedValueOnce({ _id: "3", count: 1 })
      .mockResolvedValueOnce({ _id: "4", count: 1 });

    const result = await reserveSmsUsage({
      business,
      customerPhone: "+14045550101",
      now: new Date("2026-07-30T18:15:00.000Z"),
    });

    expect(result.allowed).toBe(true);
    expect(AlertService.createSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "outbound SMS usage is at 80%",
        dedupeKey: expect.stringContaining("communication_usage:sms_outbound"),
      }),
    );
  });
});
