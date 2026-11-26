import { staffNotificationPublishAlertAtomicUpdate } from './stateTransitions/reviews.js';
import crypto from "node:crypto";
import Alert from "../models/alert.js";
import Business from "../models/business.js";
import {dispatchStaffRecipients,staffAlertDeliveryFilter} from './notifications/recipientPolicy.service.js';
import Job from "../models/staffNotificationJob.js";
import { sendStaffReviewEmail } from "../helpers/email/mailer.js";
import SocketService from "./socket.service.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";
const unresolved = { actionRequired: true, resolvedAt: null, acknowledgedAt: null };
const enabled = () => process.env.STAFF_NOTIFICATION_EMAIL_ENABLED === "true";
const publish = async (job) => {
  // Read authoritative state and fence UI updates by the job version so a slow
  // enqueue publisher cannot replace an accepted result with stale "pending".
  const current = await Job.findById(job._id).lean();
  if (!current) return;
  const field = `metadata.staffNotification.${current.stage}`;
  const alert = await staffNotificationPublishAlertAtomicUpdate({ Alert, current, field });
  if (alert) SocketService.emitAlertUpdated(current.business, alert);
  await Job.updateOne({ _id: current._id, revision: current.revision }, { $set: { published: true } });
};
export async function enqueueStaffNotifications({ now = new Date(), limit = 100 } = {}) {
  if (!enabled()) return;
  for (const stage of ["initial", "overdue", "expired"]) {
    const stageFilter = stage === "expired" ? { "metadata.approvalState": "needs_recheck" } : stage === "overdue" ? { dueAt: { $ne: null, $lte: now } } : { $or: [{ dueAt: null }, { dueAt: { $gt: now } }] };
    const required=stage==='initial'?{$or:[{priority:'critical'},unresolved]}:unresolved;
    const due=stage==='initial'?{$or:[{priority:'critical'},{dueAt:null},{dueAt:{$gt:now}}]}:stageFilter;
    const alerts=await Alert.find({$and:[required,{$or:[{priority:{$in:['high','critical']}},{'metadata.approvalRequest':true},{'metadata.serviceEligibilityReason':{$exists:true,$ne:''}}]},due],
      ...(stage==='expired'?{}:{'metadata.approvalState':{$ne:'needs_recheck'}}),[`metadata.staffNotification.${stage}`]:{$exists:false},
    }).sort({createdAt:1,_id:1}).limit(limit).select('_id business').lean();
    for (const alert of alerts) {
      // Insert before marking enqueued: a crash leaves a recoverable idempotent insert.
      let job;
      try {
        job = await Job.findOneAndUpdate({ alert: alert._id, stage }, { $setOnInsert: {
          alert: alert._id, business: alert.business, stage, nextAttemptAt: now,
        } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true });
      } catch (error) {
        if (error.code !== 11000) throw error;
        job = await Job.findOne({ alert: alert._id, stage });
      }
      if (job) await publish(job, job.status);
    }
  }
}
export async function runStaffNotificationsOnce({ now = new Date(), limit = 100, send = sendStaffReviewEmail, dispatch = dispatchStaffRecipients } = {}) {
  if (!enabled()) return { disabled: true, processed: 0 };
  limit = Math.max(1, Math.min(100, Number(limit) || 100));
  await enqueueStaffNotifications({ now, limit });
  for (const job of await Job.find({ published: false }).sort({ updatedAt: 1 }).limit(limit).lean()) await publish(job);
  // SMTP has no exactly-once delivery contract. An abandoned sending claim is
  // uncertain, never automatically resent after the sender may have accepted it.
  const abandoned = await Job.find({ status: "sending", leaseExpiresAt: { $lte: now } }).limit(limit).lean();
  for (const job of abandoned) {
    const result = await Job.updateOne({ _id: job._id, status: "sending", leaseToken: job.leaseToken },
      { $inc: { revision: 1 }, $set: { published: false, status: "uncertain", lastError: "Sender interrupted; inspect provider before retrying" } });
    if (result.modifiedCount) await publish(job, "uncertain");
  }
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    const token = crypto.randomUUID();
    const job = await Job.findOneAndUpdate({ status: "pending", nextAttemptAt: { $lte: now } }, {
      $set: { published: false, status: "sending", leaseToken: token, leaseExpiresAt: new Date(Date.now() + 120000) },
      $inc: { attempts: 1, revision: 1 },
    }, { sort: { nextAttemptAt: 1, _id: 1 }, returnDocument: "after" });
    if (!job) break;
    const fence = { _id: job._id, status: "sending", leaseToken: token };
    let status = "failed", errorCode = "", providerMessageId;
    try {
      const alert = await Alert.findOne(staffAlertDeliveryFilter({alertId:job.alert,businessId:job.business,stage:job.stage})).lean();
      const business = alert && await Business.findOne({ _id: job.business, isActive: true }).select("owner businessName").lean();

      if (!alert || !business) status = "canceled";
      else {
        // Recheck immediately before dispatch; acknowledgment still always remains
        // independent of delivery. An email already in flight cannot be recalled.
        const stillOpen = await Alert.exists(staffAlertDeliveryFilter({alertId:alert._id,businessId:job.business,stage:job.stage}));
        if (!stillOpen) status = "canceled";
        else {
          const result = await dispatch({businessId:job.business,channel:"email",critical:alert.priority==="critical",approval:alert.metadata?.approvalRequest===true,key:`alert:${alert._id}:${job.stage}`,send,shouldSend:()=>Alert.exists(staffAlertDeliveryFilter({alertId:alert._id,businessId:job.business,stage:job.stage})),payload:recipient=>({ email: recipient.address, businessName: business.businessName,
            alertId: String(alert._id), appointmentId: alert.metadata?.approvalRequest ? String(alert.appointment || alert.metadata.appointmentId || "") : null, stage: job.stage,critical:alert.priority==="critical" })});
          providerMessageId = result?.messageId;
          status = result.state === "accepted" ? "accepted" : result.state === "blocked" ? job.attempts < 3 ? "pending" : "failed" : ["canceled","failed"].includes(result.state) ? result.state : "uncertain";
          if (result.state === "blocked") errorCode = result.reason || "RECIPIENT_DELIVERY_BLOCKED";
          if (status === "uncertain") errorCode = "PROVIDER_ACCEPTANCE_UNVERIFIED";
        }
      }
    } catch (error) {
      errorCode = String(error.code || "NOTIFICATION_SEND_FAILED").slice(0, 100);
      // Only known pre-acceptance failures may be retried automatically.
      const safeToRetry = ["EMAIL_NOT_CONFIGURED", "EAUTH", "ECONNECTION", "EDNS", "ECONNREFUSED"].includes(error.code);
      status = safeToRetry ? (job.attempts < 3 ? "pending" : "failed") : "uncertain";
      logOperationalError("staff_notification.failed", error, { jobId: job._id, status });
    }
    const updated = await Job.updateOne(fence, { $inc: { revision: 1 }, $set: { published: false, status, lastError: errorCode,
      ...(providerMessageId ? { providerMessageId } : {}), nextAttemptAt: new Date(Date.now() + 60000 * job.attempts),
    }, $unset: { leaseToken: 1, leaseExpiresAt: 1 } });
    if (updated.modifiedCount) await publish(job, status);
    processed++;
  }
  return { processed };
}
