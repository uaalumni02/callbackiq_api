import Message from "../../src/models/message.js";
import SmsProcessingJob from "../../src/models/smsProcessingJob.js";
import {
  reconcileOrphanedInboundSmsJobs,
} from "../../src/services/messaging/smsProcessingQueue.service.js";

jest.mock("../../src/models/message.js", () => ({
  __esModule: true,
  default: {
    find: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock("../../src/models/smsProcessingJob.js", () => ({
  __esModule: true,
  default: {
    find: jest.fn(),
    findOneAndUpdate: jest.fn(),
  },
}));

const chain = (result) => {
  const value = {
    sort: jest.fn(),
    limit: jest.fn(),
    select: jest.fn(),
    lean: jest.fn(),
  };
  value.sort.mockReturnValue(value);
  value.limit.mockReturnValue(value);
  value.select.mockReturnValue(value);
  value.lean.mockResolvedValue(result);
  return value;
};

describe("SMS ingress orphan reconciliation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("creates the missing durable processing job and marks the Message repaired", async () => {
    const inbound = {
      _id: "m1",
      business: "b1",
      conversation: "c1",
      lead: "l1",
      providerMessageId: "SM-IN",
    };
    Message.find.mockReturnValue(chain([inbound]));
    SmsProcessingJob.find.mockReturnValue(chain([]));
    SmsProcessingJob.findOneAndUpdate.mockResolvedValue({ _id: "j1" });
    Message.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const result = await reconcileOrphanedInboundSmsJobs();

    expect(Message.find).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "inbound",
        provider: "twilio",
        "metadata.processingRequired": true,
        "metadata.processingEnqueuedAt": null,
      }),
    );
    expect(SmsProcessingJob.findOneAndUpdate).toHaveBeenCalledWith(
      { inboundMessage: "m1" },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          business: "b1",
          conversation: "c1",
          lead: "l1",
          providerMessageId: "SM-IN",
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(Message.updateOne).toHaveBeenCalledWith(
      { _id: "m1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          "metadata.processingReconciled": true,
        }),
      }),
    );
    expect(result).toEqual({ examined: 1, repaired: 1 });
  });

  test("does not create a duplicate job when the durable job already exists", async () => {
    const inbound = {
      _id: "m1",
      business: "b1",
      conversation: "c1",
      lead: "l1",
      providerMessageId: "SM-IN",
    };
    Message.find.mockReturnValue(chain([inbound]));
    SmsProcessingJob.find.mockReturnValue(
      chain([{ inboundMessage: "m1" }]),
    );
    Message.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const result = await reconcileOrphanedInboundSmsJobs();

    expect(SmsProcessingJob.findOneAndUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ examined: 1, repaired: 0 });
  });
});
