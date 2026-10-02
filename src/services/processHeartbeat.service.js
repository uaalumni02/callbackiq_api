import { automationReadiness } from './automationReadiness.service.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import Heartbeat from '../models/processHeartbeat.js';
import { socketRedisReady } from './socketRedisAdapter.service.js';
import { isDraining } from './runtimeState.service.js';
import { logOperationalError } from '../helpers/logging/safeLogger.js';
let timer, active;
const id = crypto.randomUUID();
export function startProcessHeartbeat() {
  const role = process.env.PROCESS_ROLE || 'all';
  if (timer || (!process.env.SCALE_PROFILE && !['all', 'worker', 'worker-automation'].includes(role))) return;
  const tick = () => {
    if (active) return;
    active = (async () => {
      const now = new Date();
      const ready = mongoose.connection.readyState === 1 && socketRedisReady() && !isDraining() && automationReadiness().ready;
      if (process.env.PROCESS_ROLE?.startsWith('worker')) {
        const target = process.env.WORKER_HEALTH_FILE || '/tmp/callbackiq-worker-health.json';
        await fs.writeFile(`${target}.tmp`, JSON.stringify({ seenAt: now, ready }), { mode: 0o600 });
        await fs.rename(`${target}.tmp`, target);
      }
      if (ready) await Heartbeat.updateOne({ _id: id }, { $set: { role,
        seenAt: now, ready, capacityPlan: process.env.SCALE_CAPACITY_PLAN_SHA256 || 'unrecorded', image: process.env.SCALE_IMAGE_DIGEST || 'unrecorded', release: process.env.RELEASE_SHA || 'unrecorded' } }, { upsert: true }).maxTimeMS(3000);
    })().catch(error => logOperationalError('fleet.heartbeat_failed', error)).finally(() => { active = null; });
  };
  tick(); timer = setInterval(tick, 10000); timer.unref?.();
}
export async function stopProcessHeartbeat() { clearInterval(timer); timer = null; await active; }
