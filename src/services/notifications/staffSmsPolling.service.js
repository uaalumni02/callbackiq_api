import {recordStaffSmsDelivery} from '../stateTransitions/reviews.js';
import Alert from "../../models/alert.js";
import Business from "../../models/business.js";
import Cursor from "../../models/staffNotificationCursor.js";
import { dispatchStaffRecipients,staffAlertDeliveryFilter } from "./recipientPolicy.service.js";
import { sendSms } from "../twilioSmsService.js";
import {
  withDistributedLease,
  assertDistributedLeaseActive,
} from "../distributedLease.service.js";
import { numericSetting } from "../../config/numericSettings.js";
import { logOperationalError } from "../../helpers/logging/safeLogger.js";
const unresolved = {
  actionRequired: true,
  resolvedAt: null,
  acknowledgedAt: null,
};
const stageFor = (alert, approval, now) => {
  const stages = approval
    ? alert.metadata?.approvalSms
    : alert.metadata?.staffSms;
  if (approval && alert.metadata?.approvalState === "needs_recheck")
    return "expired";
  if (
    !stages?.initial ||
    stages.initial.state === "blocked" ||
    stages.initial.state === "sending"
  )
    return "initial";
  return alert.dueAt && new Date(alert.dueAt) <= now ? "overdue" : null;
};
const notice = (alert, stage, approval) => {
  const link = new URL(
    approval ? "/appointments" : "/intervention-center",
    process.env.CLIENT_URL,
  );
  if (!["http:", "https:"].includes(link.protocol))
    throw new Error("Invalid application URL");
  link.searchParams.set(
    approval ? "appointmentId" : "alertId",
    String(
      approval ? alert.appointment || alert.metadata?.appointmentId : alert._id,
    ),
  );
  if(alert.priority==='critical')return `MeekCall: An urgent safety concern was reported. Review the record immediately: ${link}. A team member may already be responding. MeekCall does not dispatch emergency help.`;
  return `MeekCall: ${alert.priority === "critical" ? "An urgent safety concern" : approval ? stage==="expired" ? "An appointment reservation expired; the request" : "An appointment request" : "A customer request"} ${stage === "overdue" ? "still needs your attention" : stage === "expired" ? "needs an availability recheck" : "needs your attention"}. Review and contact the customer: ${link}. Sign-in required.`;
};
const dispatchAlert = async ({ alert, business, approval, now, send }) => {
  const stage = stageFor(alert, approval, now);
  if (!stage) return false;
  const path = `metadata.${approval ? "approvalSms" : "staffSms"}.${stage}`;
  const previous = approval
    ? alert.metadata?.approvalSms?.[stage]
    : alert.metadata?.staffSms?.[stage];
  if (previous && previous.state !== "blocked" && previous.state !== "sending")
    return false;
  assertDistributedLeaseActive();
  if (
    !(await Alert.exists(staffAlertDeliveryFilter({alertId:alert._id,businessId:alert.business,stage})))
  )
    return false;
  const result = await dispatchStaffRecipients({
    businessId: alert.business,
    channel: "sms",
    critical: alert.priority === "critical",
    approval,
    key: `alert:${alert._id}:${stage}`,
    send,
    shouldSend: () =>
      Alert.exists(staffAlertDeliveryFilter({alertId:alert._id,businessId:alert.business,stage})),
    payload: (recipient) => ({
      business,
      to: recipient.address,
      body: notice(alert, stage, approval),
      source: approval ? "staff_approval_notice" : "staff_request_notice",
      actorType: "system",
      usageCategory: "sms",
      bypassQuietHours: alert.priority === "critical",
      metadata: {
        idempotencyKey: `staff:${alert._id}:${stage}:${recipient.hash}`,
      },
    }),
  });
  const state = result.state === "accepted" ? "sent" : result.state;
  await recordStaffSmsDelivery({Alert,filter:staffAlertDeliveryFilter({alertId:alert._id,businessId:alert.business,stage}),path,state,now,result});
  return state === "sent";
};
const nextAlertPage = async (options) => {
  const cursor = await Cursor.findById(options.kind).lean();
  const batch = Math.max(
    1,
    Math.min(
      numericSetting("PILOT_STAFF_SMS_PAGE_SIZE"),
      Number(options.limit) || 25,
    ),
  );
  const initialPath=`metadata.${options.approval?"approvalSms":"staffSms"}.initial`;
  const filter = {
    $or:[unresolved,{priority:'critical',$or:[{[initialPath]:{$exists:false}},{[`${initialPath}.state`]:{$in:['blocked','sending']}}]}],
    "metadata.approvalRequest": options.approval ? true : { $ne: true },
    ...(!options.approval ? { priority: { $in: ["high", "critical"] } } : {}),
    ...(cursor?.afterId ? { _id: { $gt: cursor.afterId } } : {}),
  };
  const alerts = await Alert.find(filter).sort({ _id: 1 }).limit(batch).lean();
  return { alerts, batch };
};
/** Processes bounded, leased keyset pages partitioned by approval/general work; no full tenant-policy scan. */
export async function pollStaffSms({
  approval = false,
  limit = 100,
  now = new Date(),
  send = sendSms,
} = {}) {
  if (
    approval
      ? process.env.STAFF_APPROVAL_SMS_ENABLED !== "true"
      : process.env.STAFF_NOTIFICATION_SMS_ENABLED === "false"
  )
    return { disabled: true, sent: 0 };
  const kind = approval ? "approval" : "general";
  const result = await withDistributedLease(
    `staff-sms-page:${kind}`,
    async () => {
      const { alerts, batch } = await nextAlertPage({ kind, approval, limit });
      const businesses = await Business.find({
        _id: {
          $in: [...new Set(alerts.map((alert) => String(alert.business)))],
        },
        isActive: true,
      }).lean();
      const byId = new Map(businesses.map((b) => [String(b._id), b]));
      let sent = 0;
      for (const alert of alerts) {
        const business = byId.get(String(alert.business));
        if (!business) continue;
        try {
          sent += Number(
            await dispatchAlert({ alert, business, approval, now, send }),
          );
        } catch (error) {
          logOperationalError("staff_sms.delivery_failed", error, {
            businessId: alert.business,
            alertId: alert._id,
          });
        }
      }
      assertDistributedLeaseActive();
      await Cursor.updateOne(
        { _id: kind },
        {
          $set: { afterId: alerts.length === batch ? alerts.at(-1)._id : null },
        },
        { upsert: true },
      );
      return { sent, scanned: alerts.length };
    },
    { ttlMs: numericSetting("PILOT_NOTIFICATION_LEASE_MS") },
  );
  return result.acquired ? result.value : { sent: 0, busy: true };
}
