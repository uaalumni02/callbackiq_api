import mongoose from "mongoose";
const schema = new mongoose.Schema({
  _id: String,
  kind: { type: String, enum: ["recovery_sms", "missed_followup"], required: true },
  business: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  status: { type: String, enum: ["queued", "processing", "completed", "dead"], default: "queued" },
  availableAt: { type: Date, default: Date.now },
  leaseUntil: Date,
  leaseToken: String,
  attempts: { type: Number, default: 0 },
  lastErrorCode: String,
  completedAt: Date,
  staffReviewAlertRecorded: { type: Boolean, default: false },
}, { timestamps: true });
schema.index({ status: 1, availableAt: 1, createdAt: 1 });
schema.index({ status: 1, leaseUntil: 1 });
schema.index({ status: 1, createdAt: 1 });
schema.index({ status: 1, staffReviewAlertRecorded: 1, updatedAt: 1, _id: 1 });
// Completed identities intentionally remain: an old provider replay must not
// silently resurrect a previously completed customer communication.
export default mongoose.models.WebhookWork || mongoose.model("WebhookWork", schema);
