import crypto from "crypto";
import WebhookWork from "../../models/webhookWork.js";
export const durableWebhookWorkEnabled = () => process.env.RECOVERY_SMS_ASYNC_ENABLED !== "false";
export const enqueueWebhookWork = async ({ kind, businessId, eventId, payload }) => {
  if (!eventId || !businessId) throw new Error("Durable webhook work requires event and business identity");
  const _id = crypto.createHash("sha256").update(`${kind}:${businessId}:${eventId}`).digest("hex");
  try {
    return await WebhookWork.findOneAndUpdate({ _id }, { $setOnInsert: {
      kind, business: businessId, payload, status: "queued", availableAt: new Date(),
    } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true });
  } catch (error) {
    if (error.code === 11000) return WebhookWork.findById(_id);
    throw error;
  }
};
export const claimWebhookWork = async () => {
  const now = new Date();
  return WebhookWork.findOneAndUpdate({ $or: [
    { status: "queued", availableAt: { $lte: now } },
    { status: "processing", leaseUntil: { $lte: now } },
  ] }, { $set: { status: "processing", leaseToken: crypto.randomUUID(), leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } },
  { sort: { availableAt: 1, createdAt: 1 }, returnDocument: "after" }).lean();
};
