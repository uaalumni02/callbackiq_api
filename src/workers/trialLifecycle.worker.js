import { captureExternalError } from "../services/errorTracking.service.js";
import { reconcileTrackingNumberReleases } from '../services/trackingNumberProvisioning.service.js';
import { reconcileTrialExtensions } from '../services/trialExtension.service.js';
import { workerSetting } from '../config/workerSettings.js';
import { safeConsole } from "../helpers/logging/safeLogger.js";
import { processTrialLifecycle } from "../services/trialLifecycle.service.js";
import { reconcileStripeSubscriptionIntegrity } from "../services/subscriptionIntegrity.service.js";


let timer = null;
let running = false;
let integrityRunning = false;
let lastIntegrityRunAt = 0;

export const runTrialLifecycleOnce = async () => {
  if (running) return { skipped: true };
  running = true;
  try {
    const extensions = await reconcileTrialExtensions();
    await reconcileTrackingNumberReleases();
    const lifecycle = await processTrialLifecycle(new Date());
    if (extensions.errors.length) safeConsole.error("trial.extension.reconciliation_incomplete", extensions);
    return lifecycle;
  } finally {
    running = false;
  }
};

export const runSubscriptionIntegrityOnce = async ({ force = false } = {}) => {
  const intervalMs = workerSetting('BILLING_INTEGRITY_INTERVAL_MS');

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
    captureExternalError(error);
    safeConsole.error("Initial trial lifecycle run failed:", error);
  });
  await runSubscriptionIntegrityOnce({ force: true }).catch((error) => {
    captureExternalError(error);
    safeConsole.error("Initial Stripe billing integrity run failed:", error);
  });

  const intervalMs = workerSetting('TRIAL_LIFECYCLE_INTERVAL_MS');

  timer = setInterval(() => {
    void runTrialLifecycleOnce().catch((error) => {
    captureExternalError(error);
      safeConsole.error("Trial lifecycle worker failed:", error);
    });
    void runSubscriptionIntegrityOnce().catch((error) => {
    captureExternalError(error);
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
