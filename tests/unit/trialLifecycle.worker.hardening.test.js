jest.mock("../../src/services/trialLifecycle.service.js", () => ({
  __esModule: true,
  processTrialLifecycle: jest.fn(),
}));

jest.mock("../../src/services/subscriptionIntegrity.service.js", () => ({
  __esModule: true,
  reconcileStripeSubscriptionIntegrity: jest.fn(),
}));

import { processTrialLifecycle } from "../../src/services/trialLifecycle.service.js";
import { reconcileStripeSubscriptionIntegrity } from "../../src/services/subscriptionIntegrity.service.js";
import {
  runSubscriptionIntegrityOnce,
  runTrialLifecycleOnce,
  startTrialLifecycleWorker,
  stopTrialLifecycleWorker,
} from "../../src/workers/trialLifecycle.worker.js";

const mockProcessTrialLifecycle = processTrialLifecycle;
const mockReconcileStripeSubscriptionIntegrity =
  reconcileStripeSubscriptionIntegrity;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("trialLifecycle.worker hardening", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalInterval = process.env.TRIAL_LIFECYCLE_INTERVAL_MS;
  const originalIntegrityInterval = process.env.BILLING_INTEGRITY_INTERVAL_MS;

  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    stopTrialLifecycleWorker();
    process.env.NODE_ENV = "test";
    delete process.env.TRIAL_LIFECYCLE_INTERVAL_MS;
    delete process.env.BILLING_INTEGRITY_INTERVAL_MS;
    mockReconcileStripeSubscriptionIntegrity.mockResolvedValue({ processed: 0 });
  });

  afterEach(() => {
    stopTrialLifecycleWorker();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalInterval === undefined) {
      delete process.env.TRIAL_LIFECYCLE_INTERVAL_MS;
    } else {
      process.env.TRIAL_LIFECYCLE_INTERVAL_MS = originalInterval;
    }
    if (originalIntegrityInterval === undefined) {
      delete process.env.BILLING_INTEGRITY_INTERVAL_MS;
    } else {
      process.env.BILLING_INTEGRITY_INTERVAL_MS = originalIntegrityInterval;
    }
  });

  test("runs the lifecycle with a concrete Date", async () => {
    mockProcessTrialLifecycle.mockResolvedValueOnce({ processed: 3 });
    await expect(runTrialLifecycleOnce()).resolves.toEqual({ processed: 3 });
    expect(mockProcessTrialLifecycle).toHaveBeenCalledTimes(1);
    expect(mockProcessTrialLifecycle.mock.calls[0][0]).toBeInstanceOf(Date);
  });

  test("skips a concurrent invocation while the first run is active", async () => {
    const gate = deferred();
    mockProcessTrialLifecycle.mockReturnValueOnce(gate.promise);

    const first = runTrialLifecycleOnce();
    await Promise.resolve();

    await expect(runTrialLifecycleOnce()).resolves.toEqual({ skipped: true });
    gate.resolve({ processed: 1 });
    await expect(first).resolves.toEqual({ processed: 1 });
  });

  test("releases the reentrancy guard after a lifecycle failure", async () => {
    mockProcessTrialLifecycle
      .mockRejectedValueOnce(new Error("Stripe unavailable"))
      .mockResolvedValueOnce({ processed: 0 });

    await expect(runTrialLifecycleOnce()).rejects.toThrow("Stripe unavailable");
    await expect(runTrialLifecycleOnce()).resolves.toEqual({ processed: 0 });
    expect(mockProcessTrialLifecycle).toHaveBeenCalledTimes(2);
  });

  test("runs subscription integrity on force and throttles an immediate non-forced repeat", async () => {
    mockReconcileStripeSubscriptionIntegrity.mockResolvedValueOnce({ processed: 2 });
    await expect(runSubscriptionIntegrityOnce({ force: true })).resolves.toEqual({
      processed: 2,
    });
    await expect(runSubscriptionIntegrityOnce()).resolves.toEqual({ skipped: true });
    expect(mockReconcileStripeSubscriptionIntegrity).toHaveBeenCalledTimes(1);
  });

  test("releases the subscription-integrity reentrancy guard after failure", async () => {
    mockReconcileStripeSubscriptionIntegrity
      .mockRejectedValueOnce(new Error("integrity failed"))
      .mockResolvedValueOnce({ processed: 1 });

    await expect(
      runSubscriptionIntegrityOnce({ force: true }),
    ).rejects.toThrow("integrity failed");
    await expect(
      runSubscriptionIntegrityOnce({ force: true }),
    ).resolves.toEqual({ processed: 1 });
  });

  test("never schedules the interval in NODE_ENV=test", async () => {
    mockProcessTrialLifecycle.mockResolvedValue({ processed: 0 });
    await startTrialLifecycleWorker();
    expect(mockProcessTrialLifecycle).not.toHaveBeenCalled();
  });

  test("runs immediately and on the configured interval outside test mode", async () => {
    jest.useFakeTimers();
    process.env.NODE_ENV = "development";
    process.env.TRIAL_LIFECYCLE_INTERVAL_MS = "250";
    mockProcessTrialLifecycle.mockResolvedValue({ processed: 0 });

    await startTrialLifecycleWorker();
    expect(mockProcessTrialLifecycle).toHaveBeenCalledTimes(1);
    expect(mockReconcileStripeSubscriptionIntegrity).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(250);
    expect(mockProcessTrialLifecycle).toHaveBeenCalledTimes(2);
  });
});
