const mockFindOne = jest.fn();
const mockFind = jest.fn();
const mockUpdateManyJob = jest.fn();
const mockUpdateManyMessage = jest.fn();

jest.mock("../../src/models/message.js", () => ({
  __esModule: true,
  default: { findOne: mockFindOne, find: mockFind, updateMany: mockUpdateManyMessage },
}));
jest.mock("../../src/models/smsProcessingJob.js", () => ({
  __esModule: true,
  default: { updateMany: mockUpdateManyJob },
}));

const { loadCustomerTurn, completeCoalescedJobs } = require("../../src/services/messaging/smsTurnAggregation.service.js");

const chain = (value) => ({
  sort: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
});

describe("SMS burst coalescing", () => {
  beforeEach(() => jest.clearAllMocks());

  test("three inbound fragments become one customer turn", async () => {
    mockFindOne.mockReturnValue(chain({ _id: "out-1", createdAt: new Date("2026-09-01T10:00:00Z") }));
    mockFind
      .mockReturnValueOnce(chain([
        { _id: "m1", direction: "inbound", body: "My address is 123 Main St", createdAt: new Date("2026-09-01T10:01:00Z") },
        { _id: "m2", direction: "inbound", body: "Atlanta", createdAt: new Date("2026-09-01T10:01:01Z") },
        { _id: "m3", direction: "inbound", body: "30309", createdAt: new Date("2026-09-01T10:01:02Z") },
      ]))
      .mockReturnValueOnce(chain([
        { _id: "old", direction: "outbound", body: "What is the address?", createdAt: new Date("2026-09-01T10:00:00Z") },
      ]));

    const result = await loadCustomerTurn({
      conversationId: "c1",
      anchorMessage: { _id: "m1", body: "My address is 123 Main St", createdAt: new Date("2026-09-01T10:01:00Z"), metadata: {} },
    });

    expect(result.customerMessage).toBe("My address is 123 Main St\nAtlanta\n30309");
    expect(result.turnMessageIds).toHaveLength(3);
    expect(result.historyMessages.at(-1).body).toBe(result.customerMessage);
  });

  test("older jobs are completed as coalesced into the primary", async () => {
    mockUpdateManyJob.mockResolvedValue({ modifiedCount: 2 });
    mockUpdateManyMessage.mockResolvedValue({ modifiedCount: 2 });
    const result = await completeCoalescedJobs({
      conversationId: "c1",
      primaryJobId: "j1",
      primaryMessageId: "m1",
      turnMessageIds: ["m1", "m2", "m3"],
    });
    expect(result.modifiedCount).toBe(2);
    expect(mockUpdateManyJob).toHaveBeenCalledWith(
      expect.objectContaining({ inboundMessage: { $in: ["m2", "m3"] } }),
      expect.objectContaining({ $set: expect.objectContaining({ status: "completed", coalescedInto: "j1" }) }),
    );
  });
});
