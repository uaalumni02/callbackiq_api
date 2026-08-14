const mockClaimNextInboundSmsJob = jest.fn();
const mockCompleteInboundSmsJob = jest.fn();
const mockFailInboundSmsJob = jest.fn();
const mockHeartbeatInboundSmsJob = jest.fn();
const mockSafelyProcessInboundSmsJob = jest.fn();
const mockCreateSystemAlert = jest.fn();
const mockLogOperationalEvent = jest.fn();
const mockLogOperationalError = jest.fn();

jest.mock(
  "../../src/services/messaging/smsProcessingQueue.service.js",
  () => ({
    claimNextInboundSmsJob: mockClaimNextInboundSmsJob,
    completeInboundSmsJob: mockCompleteInboundSmsJob,
    failInboundSmsJob: mockFailInboundSmsJob,
    heartbeatInboundSmsJob: mockHeartbeatInboundSmsJob,
  }),
);

jest.mock(
  "../../src/services/messaging/inboundSmsJobProcessor.service.js",
  () => ({
    safelyProcessInboundSmsJob: mockSafelyProcessInboundSmsJob,
  }),
);

jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: {
    createSystemAlert: mockCreateSystemAlert,
  },
}));

jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  logOperationalEvent: mockLogOperationalEvent,
  logOperationalError: mockLogOperationalError,
}));

const {
  drainSmsProcessingQueueOnce,
  startSmsProcessingWorker,
  stopSmsProcessingWorker,
} = require("../../src/workers/smsProcessing.worker.js");

const job = (overrides = {}) => ({
  _id: "job-1",
  leaseToken: "lease-1",
  business: "business-1",
  conversation: "conversation-1",
  inboundMessage: "message-1",
  ...overrides,
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("smsProcessing.worker hardening", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    process.env.SMS_PROCESSING_BATCH_SIZE = "10";
    process.env.SMS_PROCESSING_LEASE_MS = "60000";
    process.env.SMS_PROCESSING_WORKER_ENABLED = "true";
    mockHeartbeatInboundSmsJob.mockResolvedValue(true);
    mockCompleteInboundSmsJob.mockResolvedValue(true);
    mockFailInboundSmsJob.mockResolvedValue({ status: "queued", attemptCount: 1 });
    mockCreateSystemAlert.mockResolvedValue({});
  });

  afterEach(() => {
    stopSmsProcessingWorker();
    process.env = { ...originalEnv };
  });

  test("claims, processes, and completes a job with the exact lease token", async () => {
    const current = job();
    const result = { conversationId: "conversation-1", replySent: true };
    mockClaimNextInboundSmsJob
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(null);
    mockSafelyProcessInboundSmsJob.mockResolvedValue(result);

    await expect(drainSmsProcessingQueueOnce()).resolves.toEqual({
      processed: 1,
      skipped: false,
    });

    expect(mockSafelyProcessInboundSmsJob).toHaveBeenCalledWith(current);
    expect(mockCompleteInboundSmsJob).toHaveBeenCalledWith({
      jobId: current._id,
      leaseToken: current.leaseToken,
      result,
    });
    expect(mockFailInboundSmsJob).not.toHaveBeenCalled();
  });

  test("prevents a second concurrent drain from processing the same queue", async () => {
    const current = job();
    const gate = deferred();
    mockClaimNextInboundSmsJob
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(null);
    mockSafelyProcessInboundSmsJob.mockReturnValueOnce(gate.promise);

    const first = drainSmsProcessingQueueOnce();
    await Promise.resolve();

    await expect(drainSmsProcessingQueueOnce()).resolves.toEqual({
      processed: 0,
      skipped: true,
    });

    gate.resolve({ ok: true });
    await expect(first).resolves.toEqual({ processed: 1, skipped: false });
  });

  test("records a retryable failure without creating a permanent-failure alert", async () => {
    const current = job();
    const error = Object.assign(new Error("temporary provider outage"), {
      code: "ETIMEDOUT",
    });
    mockClaimNextInboundSmsJob
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(null);
    mockSafelyProcessInboundSmsJob.mockRejectedValueOnce(error);
    mockFailInboundSmsJob.mockResolvedValueOnce({
      status: "queued",
      attemptCount: 2,
    });

    await expect(drainSmsProcessingQueueOnce()).resolves.toEqual({
      processed: 1,
      skipped: false,
    });

    expect(mockFailInboundSmsJob).toHaveBeenCalledWith({
      job: current,
      leaseToken: current.leaseToken,
      error,
    });
    expect(mockCreateSystemAlert).not.toHaveBeenCalled();
  });

  test("creates a deduplicated critical alert when retries are exhausted", async () => {
    const current = job();
    const error = new Error("permanent failure");
    mockClaimNextInboundSmsJob
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(null);
    mockSafelyProcessInboundSmsJob.mockRejectedValueOnce(error);
    mockFailInboundSmsJob.mockResolvedValueOnce({
      status: "dead",
      attemptCount: 5,
    });

    await drainSmsProcessingQueueOnce();

    expect(mockCreateSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: current.business,
        priority: "critical",
        dedupeKey: `sms_processing_dead:${current._id}`,
        metadata: expect.objectContaining({
          jobId: String(current._id),
          attempts: 5,
        }),
      }),
    );
  });

  test("heartbeats a long-running lease while processing is in flight", async () => {
    jest.useFakeTimers();
    process.env.SMS_PROCESSING_LEASE_MS = "15000";
    const current = job();
    const gate = deferred();
    mockClaimNextInboundSmsJob
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(null);
    mockSafelyProcessInboundSmsJob.mockReturnValueOnce(gate.promise);

    const draining = drainSmsProcessingQueueOnce();
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(5000);
    expect(mockHeartbeatInboundSmsJob).toHaveBeenCalledWith({
      jobId: current._id,
      leaseToken: current.leaseToken,
    });

    gate.resolve({ ok: true });
    await draining;
  });

  test("does not start when explicitly disabled", async () => {
    process.env.SMS_PROCESSING_WORKER_ENABLED = "false";
    await startSmsProcessingWorker();
    expect(mockClaimNextInboundSmsJob).not.toHaveBeenCalled();
  });
});
