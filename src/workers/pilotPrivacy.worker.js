import { runPilotMaintenanceOnce } from "../services/privacy/pilotMaintenance.service.js";
import { numericSetting } from "../config/numericSettings.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";
import { withDeadline } from "../services/boundedRedis.service.js";
let timer,
  active,
  stopping = true;
/** Starts bounded redaction/reaping/deletion retries; shared leases prevent duplicated tasks across instances. */
export function startPilotPrivacyWorker() {
  if (!stopping) return;
  stopping = false;
  const tick = () => {
    if (stopping) return;
    active = runPilotMaintenanceOnce()
      .catch((error) => logOperationalError("privacy.worker_failed", error))
      .finally(() => {
        active = null;
        if (!stopping) {
          timer = setTimeout(tick, numericSetting("PILOT_PRIVACY_SWEEP_MS"));
          timer.unref?.();
        }
      });
  };
  tick();
}
/** Stops new claims and bounds drain; unfinished work remains available to the next leased sweep. */
export async function stopPilotPrivacyWorker() {
  stopping = true;
  clearTimeout(timer);
  if (active)
    await withDeadline(
      active,
      numericSetting("PILOT_PRIVACY_LEASE_MS"),
      "PRIVACY_DRAIN_TIMEOUT",
    );
}
