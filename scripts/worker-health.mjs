import fs from 'node:fs/promises';
try {
  const state = JSON.parse(await fs.readFile(process.env.WORKER_HEALTH_FILE || '/tmp/callbackiq-worker-health.json', 'utf8'));
  if (!(Date.now() - new Date(state.seenAt).getTime() < 45000) || (process.argv.includes('--ready') && !state.ready)) process.exitCode = 1;
} catch { process.exitCode = 1; }
