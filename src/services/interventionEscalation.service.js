import Alert from "../models/alert.js";
import SocketService from "./socket.service.js";

// The persisted dueAt uses the configured review SLA. Escalation stays in-app;
// it must not be represented as an email/SMS delivery or staff acceptance.
export async function escalateOverdueInterventions({ now = new Date(), limit = 100 } = {}) {
  const eligible = { actionRequired: true, resolvedAt: null, acknowledgedAt: null,
    dueAt: { $lte: now, $ne: null }, "metadata.reviewEscalatedAt": { $exists: false } };
  const candidates = await Alert.find(eligible).sort({ dueAt: 1, _id: 1 }).limit(Math.max(1, Math.min(250, limit))).select("_id business").lean();
  let escalated = 0;
  for (const candidate of candidates) {
    // Recheck staff acknowledgment atomically: a completed review must not reopen.
    const alert = await Alert.findOneAndUpdate({ ...eligible, _id: candidate._id, business: candidate.business }, {
      $set: { priority: "critical", "metadata.reviewEscalatedAt": now },
    }, { returnDocument: "after", runValidators: true });
    if (!alert) continue;
    escalated += 1;
    SocketService.emitAlertUpdated(candidate.business, alert);
    SocketService.emitDashboardRefresh(candidate.business, "intervention:overdue");
  }
  return { escalated };
}
