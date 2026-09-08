import SmsProcessingJob from "../../src/models/smsProcessingJob.js";
import {
  claimNextInboundSmsJob,
  failInboundSmsJob,
  heartbeatInboundSmsJob,
  completeInboundSmsJob,
} from "../../src/services/messaging/smsProcessingQueue.service.js";

jest.mock("../../src/models/smsProcessingJob.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
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


test("expired job owner cannot renew or complete after its processing deadline", async () => {
  const expiredAt = new Date(Date.now() - 1000);
  const matchesActiveLease = filter => filter.leaseToken === "old-owner" && expiredAt > filter.leaseExpiresAt.$gt;
  SmsProcessingJob.updateOne.mockImplementation(async filter => ({ matchedCount: matchesActiveLease(filter) ? 1 : 0 }));
  SmsProcessingJob.findOneAndUpdate.mockImplementation(async filter => matchesActiveLease(filter) ? { status: "completed" } : null);
  await expect(heartbeatInboundSmsJob({ jobId: "job-1", leaseToken: "old-owner" })).resolves.toEqual({ matchedCount: 0 });
  await expect(completeInboundSmsJob({ jobId: "job-1", leaseToken: "old-owner", result: { replySent: true } })).resolves.toBeNull();
});
