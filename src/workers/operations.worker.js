import { maintainStaffReviewRecords } from '../services/staffReviewReconciliation.service.js';
import { reconcileOpsAlerts, dispatchOpsEvents, setOpsIncident } from '../services/opsPaging.service.js';
import { readScaleHealth } from '../services/scaleHealth.service.js';
import { recoverFailedSmsStaffReviews, recoverFailedWebhookReviews } from '../services/smsStaffReviewRecovery.service.js';
import { logOperationalError } from '../helpers/logging/safeLogger.js';
import { withDeadline } from '../services/boundedRedis.service.js';
let timer, active, stopping = true;
export function startOperationsWorker() {
  if (!stopping) return;
  stopping = false;
  const tick = () => {
    if (stopping) return;
    active = (async () => {
      // Recovery remains useful even when the paging provider is unavailable.
      await recoverFailedSmsStaffReviews({ limit: 250 });
      await recoverFailedWebhookReviews({ limit: 250 });
      await maintainStaffReviewRecords().catch(error => logOperationalError('staff_review.maintenance_failed', error));
      await reconcileOpsAlerts({ limit: 250 });
      const health = await readScaleHealth();
      await setOpsIncident({ key: 'fleet-health', active: !health.healthy, reason: 'fleet_health_requires_review' });
      await Promise.all(Array.from({ length: 4 }, () => dispatchOpsEvents({ limit: 10 })));
    })().catch(error => logOperationalError('operations.tick_failed', error)).finally(() => {
      active = null;
      if (!stopping) { timer = setTimeout(tick, 5000); timer.unref?.(); }
    });
  };
  tick();
}
export async function stopOperationsWorker() {
  stopping = true; clearTimeout(timer); timer = null;
  if (active) await withDeadline(active, 120000, 'OPERATIONS_DRAIN_TIMEOUT');
}
