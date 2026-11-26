import { assertProviderEntitlement } from "../providerEntitlement.service.js";
import crypto from "node:crypto";
import Business from "../../models/business.js";
import User from "../../models/user.js";
import Operations from "../../models/businessOperationsSettings.js";
import Policy from "../../models/schedulingPolicy.js";
import Delivery from "../../models/staffNotificationDelivery.js";
import { numericSetting } from "../../config/numericSettings.js";
const email = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || "");
const phone = (value) => /^\+1\d{10}$/.test(value || "");
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const safeRetry = (code) =>
  [
    "EMAIL_NOT_CONFIGURED",
    "EAUTH",
    "ECONNECTION",
    "EDNS",
    "ECONNREFUSED",
  ].includes(code);
/** Resolves opted-in saved recipients per tenant/channel; urgent recipients are unconditional for critical safety alerts. */
export async function resolveStaffRecipients({
  businessId,
  channel,
  critical = false,
  approval = false,
}) {
  const business = await Business.findOne({ _id: businessId, isActive: true })
    .select("owner")
    .lean();
  if (!business) return [];
  const ops = await Operations.findOne({ business: businessId }).lean();
  const explicit = ops?.humanHandoffContacts || [];
  const recipients = explicit
    .filter((contact) => contact.active && (!contact.emergencyOnly || critical))
    .map((contact) => (channel === "email" ? contact.email : contact.phone));
  if (!explicit.length) {
    if (channel === "email") {
      const owner = await User.findById(business.owner)
        .select("email emailVerifiedAt")
        .lean();
      if (owner?.emailVerifiedAt) recipients.push(owner.email);
    } else {
      const policy = await Policy.findOne({ business: businessId }).lean();
      if (approval ? policy?.approvalSmsEnabled : policy?.staffSmsEnabled)
        recipients.push(
          approval ? policy.approvalSmsPhone : policy.staffSmsPhone,
        );
    }
  }
  if (critical)
    recipients.push(
      channel === "email"
        ? ops?.emergencyPolicy?.emergencyContactEmail
        : ops?.emergencyPolicy?.emergencyContactPhone,
    );
  const normalize = (value) => String(value || "").trim();
  const values = recipients
    .map(normalize)
    .map((value) => (channel === "email" ? value.toLowerCase() : value));
  return [...new Set(values.filter(channel === "email" ? email : phone))].map(
    (address) => ({ address, hash: digest(`${channel}:${address}`) }),
  );
}
const claimDelivery = async ({ businessId, key, channel, recipient }) => {
  const identity = {
    business: businessId,
    key,
    channel,
    recipientHash: recipient.hash,
  };
  try {
    await Delivery.updateOne(
      identity,
      { $setOnInsert: { state: "pending" } },
      { upsert: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  await Delivery.updateOne(
    { ...identity, state: "sending", leaseUntil: { $lte: new Date() } },
    { $set: { state: "uncertain", lastErrorCode: "ABANDONED_PROVIDER_SEND" } },
  );
  const token = crypto.randomUUID();
  const row = await Delivery.findOneAndUpdate(
    {
      ...identity,
      state: { $in: ["pending", "blocked"] },
      nextAttemptAt: { $lte: new Date() },
    },
    {
      $set: {
        state: "sending",
        leaseToken: token,
        leaseUntil: new Date(
          Date.now() + numericSetting("PILOT_NOTIFICATION_LEASE_MS"),
        ),
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after" },
  );
  return { row, token, identity };
};
const outcome = (channel, result) =>
  channel === "email"
    ? result?.accepted?.length
      ? "accepted"
      : "uncertain"
    : result?.sid
      ? "accepted"
      : result?.suppressed || result?.policyBlocked
        ? "blocked"
        : "uncertain";
const completeDelivery = async (
  fence,
  { state, lastErrorCode, providerMessageId },
) => {
  await Delivery.updateOne(fence, {
    $set: {
      state,
      lastErrorCode,
      providerMessageId,
      nextAttemptAt: new Date(
        Date.now() + numericSetting("PILOT_NOTIFICATION_RETRY_MS"),
      ),
    },
    $unset: { leaseToken: 1, leaseUntil: 1 },
  });
};
const sendOne = async (options, recipient) => {
  const { businessId, key, channel, send, payload } = options;
  const { row, token, identity } = await claimDelivery({
    businessId,
    key,
    channel,
    recipient,
  });
  if (!row)
    return (
      (await Delivery.findOne(identity).select("state").lean())?.state ||
      "uncertain"
    );
  const fence = {
    _id: row._id,
    business: businessId,
    state: "sending",
    leaseToken: token,
  };
  let state = "uncertain",
    lastErrorCode = "",
    providerMessageId = "";
  try {
    const current = await resolveStaffRecipients(options);
    if (
      !current.some((value) => value.hash === recipient.hash) ||
      (options.shouldSend && !(await options.shouldSend()))
    )
      state = "canceled";
    else {
      await assertProviderEntitlement(businessId, "staff_notifications");
      const result = await send(payload(recipient));
      state = outcome(channel, result);
      providerMessageId = result?.sid || result?.messageId || "";
      lastErrorCode =
        state === "blocked" ? result.reason || "POLICY_BLOCKED" : "";
    }
  } catch (error) {
    lastErrorCode = String(error.code || "PROVIDER_OUTCOME_UNKNOWN").slice(
      0,
      100,
    );
    state = safeRetry(error.code)
      ? row.attempts < 3
        ? "pending"
        : "failed"
      : "uncertain";
  }
  await completeDelivery(fence, { state, lastErrorCode, providerMessageId });
  return state;
};
/** Sends independently fenced receipts to current saved recipients; unknown outcomes are never automatically resent. */
export async function dispatchStaffRecipients(options) {
  const recipients = await resolveStaffRecipients(options);
  if (!recipients.length)
    return { state: "blocked", reason: "NO_SAVED_RECIPIENTS", count: 0 };
  const states = [];
  for (const recipient of recipients)
    states.push(await sendOne(options, recipient));
  return {
    state: states.every((state) => state === "accepted")
      ? "accepted"
      : states.some((state) => ["uncertain", "sending"].includes(state))
        ? "uncertain"
        : states.some((state) => ["pending", "blocked"].includes(state))
          ? "blocked"
          : states.some((state) => state === "failed")
            ? "failed"
            : "canceled",
    count: recipients.length,
    states,
  };
}
/** Returns recent delivery receipts without destinations or provider identifiers, scoped to this tenant. */
export async function readStaffDeliveryState(businessId) {
  return Delivery.find({ business: businessId })
    .sort({ createdAt: -1 })
    .limit(12)
    .select("channel state createdAt updatedAt lastErrorCode -_id")
    .lean();
}
/** Requires critical initial safety delivery even after acknowledgment; ordinary notices stop once handled. */
export function staffAlertDeliveryFilter({alertId,businessId,stage}) {
 const open={actionRequired:true,resolvedAt:null,acknowledgedAt:null};
 return {_id:alertId,business:businessId,...(stage==='initial'?{$or:[{priority:'critical'},open]}:open)};
}
