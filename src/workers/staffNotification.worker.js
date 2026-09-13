import { runStaffNotificationsOnce } from "../services/staffNotification.service.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";
import { withDeadline } from "../services/boundedRedis.service.js";
let timer = null, active = null, stopping = true;
export function startStaffNotificationWorker() {
  if (!stopping || process.env.STAFF_NOTIFICATION_EMAIL_ENABLED !== "true") return;
  stopping = false;
  const tick = () => {
    if (stopping) return;
    // Three independent claims permit bounded SMTP concurrency across tenants.
    active = Promise.allSettled(Array.from({ length: 3 }, () => runStaffNotificationsOnce({ limit: 5 })))
      .then(results => results.forEach(result => { if (result.status === "rejected") logOperationalError("staff_notification.worker_failed", result.reason); }))
      .finally(() => { active = null; if (!stopping) { timer = setTimeout(tick, 5000); timer.unref?.(); } });
  };
  tick();
}
export async function stopStaffNotificationWorker() {
  stopping = true; clearTimeout(timer); timer = null;
  if (active) await withDeadline(active, 120000, "STAFF_NOTIFICATION_DRAIN_TIMEOUT");
}
