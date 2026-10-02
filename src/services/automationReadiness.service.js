// Progress, not process existence, determines automation health.
let progress = { started: false, lastCompletedAt: null, lastErrorAt: null };
export function markAutomationStarted() { progress.started = true; }
export function markAutomationStopped() { progress.started = false; }
export function markAutomationTick(ok) {
  progress[ok ? 'lastCompletedAt' : 'lastErrorAt'] = Date.now();
}
export function automationReadiness({ env = process.env, now = Date.now() } = {}) {
  const requiredLocally = ['all', 'worker', 'worker-automation'].includes(env.PROCESS_ROLE || 'all');
  const maxAge = Math.max(120000, (Number(env.AUTOMATION_WORKER_INTERVAL_MS) || 5000) * 3);
  const ready = progress.started && progress.lastCompletedAt !== null && now - progress.lastCompletedAt <= maxAge;
  return { requiredLocally, ready: !requiredLocally || ready, ...progress };
}
