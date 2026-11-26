import { reconcileGoogleDisconnects } from "../services/integrations/googleDisconnect.service.js";
import { withDeadline } from "../services/boundedRedis.service.js";
import { numericSetting } from "../config/numericSettings.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";
let timer,
  active,
  stopping = true;
/** Starts bounded durable revocation retries; failures stay observable without discarding grants. */
export function startIntegrationDisconnectWorker() {
  if (!stopping) return;
  stopping = false;
  const tick = () => {
    if (stopping) return;
    active = reconcileGoogleDisconnects(2)
      .catch((error) =>
        logOperationalError("google.disconnect_sweep_failed", error),
      )
      .finally(() => {
        active = null;
        if (!stopping) {
          timer = setTimeout(
            tick,
            numericSetting("PILOT_GOOGLE_DISCONNECT_POLL_MS"),
          );
          timer.unref?.();
        }
      });
  };
  tick();
}
/** Stops claiming work and bounds drain; unfinished claims recover after their lease expires. */
export async function stopIntegrationDisconnectWorker() {
  stopping = true;
  clearTimeout(timer);
  if (active)
    await withDeadline(active, numericSetting("PILOT_GOOGLE_DISCONNECT_LEASE_MS"), "GOOGLE_DISCONNECT_DRAIN_TIMEOUT");
}
