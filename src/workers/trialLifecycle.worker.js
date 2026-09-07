import { safeConsole } from "../helpers/logging/safeLogger.js";
import { processTrialLifecycle } from "../services/trialLifecycle.service.js";
import { reconcileStripeSubscriptionIntegrity } from "../services/subscriptionIntegrity.service.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_INTEGRITY_INTERVAL_MS = 24 * 60 * 60 * 1000;

let timer = null;
let running = false;
let integrityRunning = false;
let lastIntegrityRunAt = 0;

export const runTrialLifecycleOnce = async () => {
  if (running) return { skipped: true };
  running = true;
  try {
    return await processTrialLifecycle(new Date());
  } finally {
    running = false;
  }
};

export const runSubscriptionIntegrityOnce = async ({ force = false } = {}) => {
  const intervalMs =
    Number(process.env.BILLING_INTEGRITY_INTERVAL_MS) > 0
      ? Number(process.env.BILLING_INTEGRITY_INTERVAL_MS)
      : DEFAULT_INTEGRITY_INTERVAL_MS;

  if (!force && Date.now() - lastIntegrityRunAt < intervalMs) return { skipped: true };
  if (integrityRunning) return { skipped: true };

  integrityRunning = true;
  try {
    const result = await reconcileStripeSubscriptionIntegrity();
    lastIntegrityRunAt = Date.now();
    return result;
  } finally {
    integrityRunning = false;
  }
};

export const startTrialLifecycleWorker = async () => {
  if (process.env.NODE_ENV === "test" || timer) return;

  await runTrialLifecycleOnce().catch((error) => {
    safeConsole.error("Initial trial lifecycle run failed:", error);
  });
  await runSubscriptionIntegrityOnce({ force: true }).catch((error) => {
    safeConsole.error("Initial Stripe billing integrity run failed:", error);
  });

  const intervalMs =
    Number(process.env.TRIAL_LIFECYCLE_INTERVAL_MS) > 0
      ? Number(process.env.TRIAL_LIFECYCLE_INTERVAL_MS)
      : DEFAULT_INTERVAL_MS;

  timer = setInterval(() => {
    void runTrialLifecycleOnce().catch((error) => {
      safeConsole.error("Trial lifecycle worker failed:", error);
    });
    void runSubscriptionIntegrityOnce().catch((error) => {
      safeConsole.error("Stripe billing integrity worker failed:", error);
    });
  }, intervalMs);

  timer.unref?.();
};

export const stopTrialLifecycleWorker = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};

export default {
  runTrialLifecycleOnce,
  runSubscriptionIntegrityOnce,
  startTrialLifecycleWorker,
  stopTrialLifecycleWorker,
};
