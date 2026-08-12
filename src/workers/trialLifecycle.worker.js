import { processTrialLifecycle } from "../services/trialLifecycle.service.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

let timer = null;
let running = false;

export const runTrialLifecycleOnce = async () => {
  if (running) return { skipped: true };
  running = true;
  try {
    return await processTrialLifecycle(new Date());
  } finally {
    running = false;
  }
};

export const startTrialLifecycleWorker = async () => {
  if (process.env.NODE_ENV === "test" || timer) return;

  await runTrialLifecycleOnce().catch((error) => {
    console.error("Initial trial lifecycle run failed:", error);
  });

  const intervalMs =
    Number(process.env.TRIAL_LIFECYCLE_INTERVAL_MS) > 0
      ? Number(process.env.TRIAL_LIFECYCLE_INTERVAL_MS)
      : DEFAULT_INTERVAL_MS;

  timer = setInterval(() => {
    void runTrialLifecycleOnce().catch((error) => {
      console.error("Trial lifecycle worker failed:", error);
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
  startTrialLifecycleWorker,
  stopTrialLifecycleWorker,
};
