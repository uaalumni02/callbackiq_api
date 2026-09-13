import mongoose from "mongoose";
const schema = new mongoose.Schema({
  business: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
  alert: { type: mongoose.Schema.Types.ObjectId, ref: "Alert", required: true },
  stage: { type: String, enum: ["initial", "overdue"], required: true },
  status: { type: String, enum: ["pending", "sending", "accepted", "uncertain", "failed", "canceled"], default: "pending" },
  revision: { type: Number, default: 0 },
  published: { type: Boolean, default: false },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  leaseToken: String, leaseExpiresAt: Date,
  providerMessageId: String, lastError: String,
}, { timestamps: true });
// Retain identities: a webhook replay must not send the same notification again.
schema.index({ alert: 1, stage: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1, _id: 1 });
schema.index({ status: 1, leaseExpiresAt: 1 });
schema.index({ published: 1, updatedAt: 1 });
export default mongoose.models.StaffNotificationJob || mongoose.model("StaffNotificationJob", schema);
