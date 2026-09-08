const mockWithDistributedLease = jest.fn();
const mockDeferInboundSmsJob = jest.fn();
const mockCompleteInboundSmsJob = jest.fn();
const mockFailInboundSmsJob = jest.fn();
const mockHeartbeatInboundSmsJob = jest.fn();
const mockClaimNextInboundSmsJob = jest.fn();
const mockSafelyProcessInboundSmsJob = jest.fn();

jest.mock("../../src/services/distributedLease.service.js", () => ({ assertDistributedLeaseActive: jest.fn(), invalidateDistributedLease: jest.fn(), registerDistributedLeaseGuard: jest.fn(), withDistributedLease: mockWithDistributedLease }));
jest.mock("../../src/services/messaging/smsProcessingQueue.service.js", () => ({
  claimNextInboundSmsJob: mockClaimNextInboundSmsJob,
  completeInboundSmsJob: mockCompleteInboundSmsJob,
  failInboundSmsJob: mockFailInboundSmsJob,
  heartbeatInboundSmsJob: mockHeartbeatInboundSmsJob,
  deferInboundSmsJob: mockDeferInboundSmsJob,
}));
jest.mock("../../src/services/messaging/inboundSmsJobProcessor.service.js", () => ({ safelyProcessInboundSmsJob: mockSafelyProcessInboundSmsJob }));
jest.mock("../../src/services/alert.service.js", () => ({ __esModule: true, default: { createSystemAlert: jest.fn() } }));
jest.mock("../../src/helpers/logging/safeLogger.js", () => ({ logOperationalEvent: jest.fn(), logOperationalError: jest.fn() }));

const { drainSmsProcessingQueueOnce } = require("../../src/workers/smsProcessing.worker.js");

describe("conversation keyed SMS processing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "test";
    mockHeartbeatInboundSmsJob.mockResolvedValue(true);
  });

  test("busy conversation lease defers the job without processing", async () => {
    const job = { _id: "j2", business: "b1", conversation: "c1", inboundMessage: "m2", leaseToken: "job-lease" };
    mockClaimNextInboundSmsJob.mockResolvedValueOnce(job).mockResolvedValueOnce(null);
    mockWithDistributedLease.mockResolvedValue({ acquired: false, skipped: true });
    mockDeferInboundSmsJob.mockResolvedValue({ status: "queued" });

    await drainSmsProcessingQueueOnce();

    expect(mockSafelyProcessInboundSmsJob).not.toHaveBeenCalled();
    expect(mockDeferInboundSmsJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: "j2", leaseToken: "job-lease" }));
    expect(mockCompleteInboundSmsJob).not.toHaveBeenCalled();
  });
});
