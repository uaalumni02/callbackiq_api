const mockClaimNextInboundSmsJob = jest.fn();
const mockCompleteInboundSmsJob = jest.fn();
const mockFailInboundSmsJob = jest.fn();
const mockHeartbeatInboundSmsJob = jest.fn();
const mockDeferInboundSmsJob = jest.fn();
const mockSafelyProcessInboundSmsJob = jest.fn();
const mockWithDistributedLease = jest.fn();
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
    deferInboundSmsJob: mockDeferInboundSmsJob,
  }),
);

jest.mock(
  "../../src/services/messaging/inboundSmsJobProcessor.service.js",
  () => ({
    safelyProcessInboundSmsJob: mockSafelyProcessInboundSmsJob,
  }),
);

jest.mock("../../src/services/distributedLease.service.js", () => ({
  withDistributedLease: mockWithDistributedLease,
}));

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
    jest.resetAllMocks();
    mockWithDistributedLease.mockImplementation(async (_key, operation) => ({
      acquired: true,
      skipped: false,
      value: await operation(),
    }));
    process.env.SMS_PROCESSING_BATCH_SIZE = "10";
    process.env.SMS_PROCESSING_LEASE_MS = "60000";
    process.env.SMS_PROCESSING_WORKER_ENABLED = "true";
    mockHeartbeatInboundSmsJob.mockResolvedValue(true);
    mockDeferInboundSmsJob.mockResolvedValue(true);
    mockCompleteInboundSmsJob.mockResolvedValue(true);
    mockFailInboundSmsJob.mockResolvedValue({ status: "queued", attemptCount: 1 });
    mockCreateSystemAlert.mockResolvedValue({});
  });

  afterEach(async () => {
    await stopSmsProcessingWorker();
    jest.useRealTimers();
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

  test("shutdown waits for in-flight work, stops new claims, and cannot restart the startup timer", async () => {
    jest.useFakeTimers();
    const gate = deferred();
    mockClaimNextInboundSmsJob.mockResolvedValue(job());
    mockSafelyProcessInboundSmsJob.mockReturnValueOnce(gate.promise);
    const starting = startSmsProcessingWorker();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockSafelyProcessInboundSmsJob).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = stopSmsProcessingWorker().then(() => { stopped = true; });
    await jest.advanceTimersByTimeAsync(50);
    expect(stopped).toBe(false);
    expect(mockCompleteInboundSmsJob).not.toHaveBeenCalled();
    gate.resolve({ replySent: true });
    await starting;
    await jest.advanceTimersByTimeAsync(25);
    await stopping;
    expect(mockCompleteInboundSmsJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", leaseToken: "lease-1" }));
    await jest.advanceTimersByTimeAsync(60000);
    expect(mockClaimNextInboundSmsJob).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatInboundSmsJob).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("scheduled polling recovers after a claim failure and stops rescheduling on shutdown", async () => {
    jest.useFakeTimers();
    process.env.SMS_PROCESSING_INTERVAL_MS = "100";
    const error = new Error("temporary queue outage");
    mockClaimNextInboundSmsJob.mockResolvedValueOnce(null).mockRejectedValueOnce(error).mockResolvedValue(null);
    await startSmsProcessingWorker();
    await startSmsProcessingWorker(); // Starting twice must not create a second poller.
    expect(mockClaimNextInboundSmsJob).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(100);
    expect(mockLogOperationalError).toHaveBeenCalledWith("sms.processing_worker.failed", error);
    await jest.advanceTimersByTimeAsync(100);
    expect(mockClaimNextInboundSmsJob).toHaveBeenCalledTimes(3);
    await stopSmsProcessingWorker();
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockClaimNextInboundSmsJob).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("saturated scheduled batches use the busy delay and then return to idle polling", async () => {
    jest.useFakeTimers();
    process.env.SMS_PROCESSING_BATCH_SIZE = "1";
    process.env.SMS_PROCESSING_BUSY_DELAY_MS = "25";
    process.env.SMS_PROCESSING_INTERVAL_MS = "1000";
    mockClaimNextInboundSmsJob.mockResolvedValueOnce(job()).mockResolvedValueOnce(job({ _id: "job-2" })).mockResolvedValue(null);
    mockSafelyProcessInboundSmsJob.mockResolvedValue({ replySent: true });
    await startSmsProcessingWorker();
    expect(mockClaimNextInboundSmsJob).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(25);
    expect(mockCompleteInboundSmsJob).toHaveBeenCalledTimes(2);
    expect(mockLogOperationalEvent).toHaveBeenCalledWith("sms.processing_worker.batch", expect.objectContaining({ processed: 1, saturated: true }));
    await jest.advanceTimersByTimeAsync(25);
    expect(mockClaimNextInboundSmsJob).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(999);
    expect(mockClaimNextInboundSmsJob).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockClaimNextInboundSmsJob).toHaveBeenCalledTimes(4);
  });

  test("heartbeat failure is observable without duplicating work, and the timer clears after completion", async () => {
    jest.useFakeTimers();
    process.env.SMS_PROCESSING_LEASE_MS = "15000";
    const gate = deferred();
    const error = new Error("heartbeat unavailable");
    mockClaimNextInboundSmsJob.mockResolvedValueOnce(job()).mockResolvedValue(null);
    mockSafelyProcessInboundSmsJob.mockReturnValueOnce(gate.promise);
    mockHeartbeatInboundSmsJob.mockRejectedValueOnce(error);
    const drain = drainSmsProcessingQueueOnce();
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockLogOperationalError).toHaveBeenCalledWith("sms.processing_worker.heartbeat_failed", error, { jobId: "job-1", businessId: "business-1" });
    expect(mockSafelyProcessInboundSmsJob).toHaveBeenCalledTimes(1);
    gate.resolve({ replySent: true }); await drain;
    await jest.advanceTimersByTimeAsync(15000);
    expect(mockHeartbeatInboundSmsJob).toHaveBeenCalledTimes(1);
    expect(mockCompleteInboundSmsJob).toHaveBeenCalledTimes(1);
  });

  test("a busy conversation defers the claimed job without sending or completing it", async () => {
    mockClaimNextInboundSmsJob.mockResolvedValueOnce(job()).mockResolvedValue(null);
    mockWithDistributedLease.mockResolvedValueOnce({ acquired: false });
    await drainSmsProcessingQueueOnce();
    expect(mockDeferInboundSmsJob).toHaveBeenCalledWith({ jobId: "job-1", leaseToken: "lease-1", delayMs: 500, reason: "conversation_lease_busy" });
    expect(mockSafelyProcessInboundSmsJob).not.toHaveBeenCalled();
    expect(mockCompleteInboundSmsJob).not.toHaveBeenCalled();
    expect(mockFailInboundSmsJob).not.toHaveBeenCalled();
  });

  test("does not start when explicitly disabled", async () => {
    process.env.SMS_PROCESSING_WORKER_ENABLED = "false";
    await startSmsProcessingWorker();
    expect(mockClaimNextInboundSmsJob).not.toHaveBeenCalled();
  });
});
