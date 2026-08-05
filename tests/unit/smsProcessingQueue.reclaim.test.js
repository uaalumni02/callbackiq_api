import SmsProcessingJob from "../../src/models/smsProcessingJob.js";
import {
  claimNextInboundSmsJob,
  failInboundSmsJob,
} from "../../src/services/messaging/smsProcessingQueue.service.js";

jest.mock("../../src/models/smsProcessingJob.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
  },
}));

test("claims queued, retry, and expired-processing jobs with a lease", async () => {
  SmsProcessingJob.findOneAndUpdate.mockResolvedValue({
    _id: "job-1",
    status: "processing",
    attemptCount: 2,
    maxAttempts: 5,
    leaseToken: "lease",
  });
  await claimNextInboundSmsJob({ now: new Date("2026-08-05T00:00:00Z") });
  expect(SmsProcessingJob.findOneAndUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      $or: expect.arrayContaining([
        expect.objectContaining({ status: "processing" }),
      ]),
    }),
    expect.objectContaining({
      $set: expect.objectContaining({ status: "processing" }),
      $inc: { attemptCount: 1 },
    }),
    expect.objectContaining({ returnDocument: "after" }),
  );
});

test("moves exhausted jobs to dead-letter state", async () => {
  SmsProcessingJob.findOneAndUpdate.mockResolvedValue({ status: "dead" });
  await failInboundSmsJob({
    job: { _id: "job-1", attemptCount: 5, maxAttempts: 5 },
    leaseToken: "lease",
    error: new Error("provider failed"),
  });
  expect(SmsProcessingJob.findOneAndUpdate).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ $set: expect.objectContaining({ status: "dead" }) }),
    { returnDocument: "after" },
  );
});
