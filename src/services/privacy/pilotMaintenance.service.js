import Business from "../../models/business.js";
import Heartbeat from "../../models/maintenanceTaskHeartbeat.js";
import VoiceMaintenance from "../../voice/voiceSessionMaintenance.service.js";
import { deleteBusinessSafely } from "../businessDeletion.service.js";
import {
  withDistributedLease,
  assertDistributedLeaseActive,
} from "../distributedLease.service.js";
import { numericSetting } from "../../config/numericSettings.js";
import { logOperationalError } from "../../helpers/logging/safeLogger.js";
/** Retries bounded deleting-account tombstones; provider uncertainty keeps each account disabled and retryable. */
export async function retryTenantDeletions(
  limit = numericSetting("PILOT_DELETION_SWEEP_LIMIT"),
) {
  const rows = await Business.find({ "accountLifecycle.status": "deleting" })
    .sort({ "accountLifecycle.deletionStartedAt": 1, _id: 1 })
    .limit(limit)
    .select("_id");
  let completed = 0;
  for (const row of rows) {
    assertDistributedLeaseActive();
    try {
      await deleteBusinessSafely({ businessId: row._id });
      completed++;
    } catch (error) {
      logOperationalError("privacy.deletion_retry_pending", error, {
        businessId: row._id,
      });
    }
  }
  return { processed: rows.length, completed };
}
/** Runs one cross-instance leased privacy sweep; heartbeat success requires redaction, reaping and retries to finish. */
export async function runPilotMaintenanceOnce({ operations = {} } = {}) {
  return withDistributedLease(
    "pilot-privacy-maintenance",
    async () => {
      await Heartbeat.updateOne(
        { _id: "pilot-privacy" },
        { $set: { lastStartedAt: new Date() } },
        { upsert: true },
      );
      try {
        const limit = numericSetting("PILOT_PRIVACY_SWEEP_LIMIT");
        const redact = await (
          operations.redact || VoiceMaintenance.redactExpiredTranscripts
        )({ limit });
        assertDistributedLeaseActive();
        const reap = await (
          operations.reap || VoiceMaintenance.reapStaleSessions
        )({ limit });
        assertDistributedLeaseActive();
        const deletions = await (
          operations.deletions || retryTenantDeletions
        )();
        assertDistributedLeaseActive();
        if (reap.errors)
          throw Object.assign(
            new Error("Stale voice sessions could not all be processed."),
            { code: "PRIVACY_SWEEP_PARTIAL" },
          );
        const summary = {
          redacted: redact.modified || 0,
          reaped: reap.failedClosed || 0,
          deletionsCompleted: deletions.completed || 0,
        };
        await Heartbeat.updateOne(
          { _id: "pilot-privacy" },
          { $set: { lastSucceededAt: new Date(), lastErrorCode: "", summary } },
        );
        return summary;
      } catch (error) {
        await Heartbeat.updateOne(
          { _id: "pilot-privacy" },
          {
            $set: {
              lastFailedAt: new Date(),
              lastErrorCode: error.code || "PRIVACY_SWEEP_FAILED",
            },
          },
        );
        throw error;
      }
    },
    { ttlMs: numericSetting("PILOT_PRIVACY_LEASE_MS") },
  );
}
