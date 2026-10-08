import AutomationJob from "../../src/models/automationJob.js";
import AppointmentService from "../../src/services/scheduling/appointment.service.js";
import AutomationService from "../../src/services/automation/automation.service.js";

jest.mock("../../src/models/automationJob.js", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn(), updateMany: jest.fn() },
}));
jest.mock("../../src/services/scheduling/appointment.service.js", () => ({
  __esModule: true,
  default: { releaseExpiredHolds: jest.fn() },
}));
jest.mock("../../src/services/automation/automation.service.js", () => ({
  __esModule: true,
  default: { execute: jest.fn() },
}));
jest.mock("../../src/services/scheduling/appointmentNotification.service.js", () => ({
  __esModule: true,
  processDueAppointmentNotifications: jest.fn().mockResolvedValue([]),
  recoverStaleAppointmentNotificationLocks: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
}));
jest.mock("../../src/services/integrations/googleCalendarSync.service.js", () => ({
  __esModule: true,
  renewExpiringGoogleWatches: jest.fn().mockResolvedValue([]),
  sweepOrphanedGoogleEvents: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../src/workers/integrationWebhook.worker.js", () => ({
  __esModule: true,
  processQueuedIntegrationWebhooks: jest.fn().mockResolvedValue([]),
}));

import {
  processNextAutomationJob,
  startAutomationWorker,
  stopAutomationWorker,
} from "../../src/workers/automation.worker.js";

describe("automation worker", () => {
  let consoleError;
  let consoleLog;

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.AUTOMATION_WORKER_ENABLED = "false";
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    stopAutomationWorker();
    jest.useRealTimers();
    consoleError.mockRestore();
    consoleLog.mockRestore();
    delete process.env.AUTOMATION_WORKER_ENABLED;
  });

  test("returns null when no due job exists", async () => {
    AutomationJob.findOneAndUpdate.mockResolvedValue(null);
    await expect(processNextAutomationJob()).resolves.toBeNull();
  });

  test("claims and executes the oldest due job", async () => {
    const job = { _id: "job-1" };
    AutomationJob.findOneAndUpdate.mockResolvedValue(job);
    AutomationService.execute.mockResolvedValue({ status: "completed" });
    await expect(processNextAutomationJob()).resolves.toEqual({ status: "completed" });
    expect(AutomationJob.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "scheduled", lockedAt: null }),
      { $set: expect.objectContaining({ status: "processing", lockedAt: expect.any(Date), lockedBy: expect.any(String) }) },
      { sort: { executeAt: 1 }, new: true },
    );
  });

  test("logs execution failures and continues", async () => {
    AutomationJob.findOneAndUpdate.mockResolvedValue({ _id: "job-1" });
    AutomationService.execute.mockRejectedValue(new Error("send failed"));
    await expect(processNextAutomationJob()).resolves.toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      "Automation job execution failed:",
      expect.objectContaining({ jobId: "job-1", error: "send failed" }),
    );
  });

  test("does not start while disabled", async () => {
    await startAutomationWorker();
    expect(AutomationJob.updateMany).not.toHaveBeenCalled();
    expect(AppointmentService.releaseExpiredHolds).not.toHaveBeenCalled();
  });

  test("recovers stale locks, runs a tick, and schedules polling when enabled", async () => {
    process.env.AUTOMATION_WORKER_ENABLED = "true";
    AutomationJob.updateMany.mockResolvedValue({ modifiedCount: 1 });
    AppointmentService.releaseExpiredHolds.mockResolvedValue(0);
    AutomationJob.findOneAndUpdate.mockResolvedValue(null);
    await startAutomationWorker();
    expect(AutomationJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processing", lockedAt: expect.any(Object) }),
      { $set: expect.objectContaining({ status: "scheduled", failureReason: "Recovered stale worker lock." }) },
    );
    expect(AppointmentService.releaseExpiredHolds).toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("Automation worker started as"));

    await startAutomationWorker();
    expect(AutomationJob.updateMany).toHaveBeenCalledTimes(1);
    stopAutomationWorker();
  });
});

test('automation defaults on and the dedicated role rejects an explicit disable', async () => {
  delete process.env.AUTOMATION_WORKER_ENABLED;
  AutomationJob.findOneAndUpdate.mockResolvedValue(null);
  await startAutomationWorker();
  expect(AppointmentService.releaseExpiredHolds).toHaveBeenCalled();
  stopAutomationWorker();
  process.env.PROCESS_ROLE = 'worker-automation';
  process.env.AUTOMATION_WORKER_ENABLED = 'false';
  try { await expect(startAutomationWorker()).rejects.toThrow(/cannot run/); }
  finally { delete process.env.PROCESS_ROLE; delete process.env.AUTOMATION_WORKER_ENABLED; }
});

test('a surviving automation process recovers abandoned work on later ticks', async () => {
  jest.useFakeTimers(); jest.clearAllMocks();
  process.env.AUTOMATION_WORKER_ENABLED = 'true';
  AutomationJob.updateMany.mockResolvedValue({ modifiedCount: 0 });
  AutomationJob.findOneAndUpdate.mockResolvedValue(null);
  const { runAutomationTick } = await import('../../src/workers/automation.worker.js');
  try {
    await startAutomationWorker(); expect(AutomationJob.updateMany).toHaveBeenCalledTimes(1);
    jest.setSystemTime(Date.now() + 60001);
    await runAutomationTick(); expect(AutomationJob.updateMany).toHaveBeenCalledTimes(2);
  } finally { await stopAutomationWorker(); delete process.env.AUTOMATION_WORKER_ENABLED; jest.useRealTimers(); }
});
