const mockFindConnections = jest.fn();
const mockGetJobberSettings = jest.fn();
const mockRenewGoogle = jest.fn();
const mockSyncJobber = jest.fn();
const mockProcessWebhooks = jest.fn();

jest.mock("../../src/models/integrationConnection.js", () => ({
  __esModule: true,
  default: { find: (...args) => mockFindConnections(...args) },
}));
jest.mock("../../src/services/integrations/integrationSettings.service.js", () => ({
  getJobberSettings: (...args) => mockGetJobberSettings(...args),
}));
jest.mock("../../src/services/integrations/googleCalendarSync.service.js", () => ({
  renewExpiringGoogleWatches: (...args) => mockRenewGoogle(...args),
}));
jest.mock("../../src/services/integrations/jobberWorkflow.service.js", () => ({
  syncPendingQualifiedLeadsToJobber: (...args) => mockSyncJobber(...args),
}));
jest.mock("../../src/workers/integrationWebhook.worker.js", () => ({
  processQueuedIntegrationWebhooks: (...args) => mockProcessWebhooks(...args),
}));

describe("integrationMaintenance.worker target coverage", () => {
  const originalEnabled = process.env.INTEGRATION_WORKER_ENABLED;
  let worker;
  let consoleError;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    process.env.INTEGRATION_WORKER_ENABLED = "true";

    mockProcessWebhooks.mockResolvedValue([{}, null, {}, false]);
    mockFindConnections.mockResolvedValue([]);
    mockRenewGoogle.mockResolvedValue([]);
    mockGetJobberSettings.mockReturnValue({ syncQualifiedLeads: true });
    mockSyncJobber.mockResolvedValue([]);

    worker = require("../../src/workers/integrationMaintenance.worker.js");
  });

  afterEach(() => {
    worker?.stopIntegrationMaintenanceWorker?.();
    jest.useRealTimers();
    consoleError.mockRestore();
  });

  afterAll(() => {
    if (originalEnabled === undefined) delete process.env.INTEGRATION_WORKER_ENABLED;
    else process.env.INTEGRATION_WORKER_ENABLED = originalEnabled;
  });

  test("maintenance summarizes webhook, Jobber, and Google work", async () => {
    mockFindConnections.mockResolvedValue([
      { business: "biz-1" },
      { business: "biz-2" },
      { business: "biz-disabled" },
    ]);
    mockGetJobberSettings
      .mockReturnValueOnce({ syncQualifiedLeads: true })
      .mockReturnValueOnce({ syncQualifiedLeads: true })
      .mockReturnValueOnce({ syncQualifiedLeads: false });
    mockSyncJobber
      .mockResolvedValueOnce([{ id: 1 }, { id: 2, error: "provider" }, { id: 3 }])
      .mockResolvedValueOnce([{ id: 4 }]);
    mockRenewGoogle.mockResolvedValue([
      { renewed: true },
      { renewed: false },
      { renewed: true },
    ]);

    await expect(worker.runIntegrationMaintenance()).resolves.toEqual({
      webhooks: 2,
      jobberBusinesses: 2,
      jobberLeads: 3,
      watches: 2,
    });

    expect(mockProcessWebhooks).toHaveBeenCalledWith(50);
    expect(mockFindConnections).toHaveBeenCalledWith({
      provider: "jobber",
      status: "connected",
    });
    expect(mockSyncJobber).toHaveBeenNthCalledWith(1, {
      businessId: "biz-1",
      limit: 25,
    });
    expect(mockSyncJobber).toHaveBeenNthCalledWith(2, {
      businessId: "biz-2",
      limit: 25,
    });
    expect(mockSyncJobber).toHaveBeenCalledTimes(2);
    expect(mockRenewGoogle).toHaveBeenCalledTimes(1);
  });

  test("watch renewal is throttled to once per hour", async () => {
    await worker.runIntegrationMaintenance();
    await worker.runIntegrationMaintenance();
    expect(mockRenewGoogle).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60 * 60_000 + 1);
    await worker.runIntegrationMaintenance();
    expect(mockRenewGoogle).toHaveBeenCalledTimes(2);
  });

  test("running guard prevents reentrant execution", async () => {
    let release;
    mockProcessWebhooks.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const first = worker.runIntegrationMaintenance();
    await Promise.resolve();

    await expect(worker.runIntegrationMaintenance()).resolves.toEqual({
      skipped: true,
    });

    release([]);
    await first;
  });

  test("running flag is released even when maintenance throws", async () => {
    mockProcessWebhooks.mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(worker.runIntegrationMaintenance()).rejects.toThrow("queue unavailable");

    mockProcessWebhooks.mockResolvedValueOnce([]);
    await expect(worker.runIntegrationMaintenance()).resolves.toMatchObject({
      webhooks: 0,
    });
  });

  test("disabled worker does not schedule or execute", async () => {
    process.env.INTEGRATION_WORKER_ENABLED = "false";
    await worker.startIntegrationMaintenanceWorker();
    expect(mockProcessWebhooks).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("start performs one immediate pass and schedules recurring maintenance", async () => {
    await worker.startIntegrationMaintenanceWorker();

    expect(mockProcessWebhooks).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(5 * 60_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockProcessWebhooks.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("calling start twice does not create duplicate interval", async () => {
    await worker.startIntegrationMaintenanceWorker();
    const timerCount = jest.getTimerCount();
    await worker.startIntegrationMaintenanceWorker();
    expect(jest.getTimerCount()).toBe(timerCount);
  });

  test("startup failure is logged but worker still installs interval", async () => {
    mockProcessWebhooks.mockRejectedValueOnce(new Error("startup failed"));
    await worker.startIntegrationMaintenanceWorker();
    expect(consoleError).toHaveBeenCalledWith(
      "Integration maintenance startup failed:",
      "startup failed",
    );
    expect(jest.getTimerCount()).toBe(1);
  });

  test("interval failure is caught and logged", async () => {
    await worker.startIntegrationMaintenanceWorker();

    mockProcessWebhooks.mockRejectedValueOnce(new Error("tick failed"));
    jest.advanceTimersByTime(5 * 60_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith(
      "Integration maintenance failed:",
      "tick failed",
    );
  });

  test("stop is idempotent and clears timer", async () => {
    await worker.startIntegrationMaintenanceWorker();
    expect(jest.getTimerCount()).toBe(1);
    worker.stopIntegrationMaintenanceWorker();
    expect(jest.getTimerCount()).toBe(0);
    expect(() => worker.stopIntegrationMaintenanceWorker()).not.toThrow();
  });
});
