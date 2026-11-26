import "../helpers/model/tenantContext.js";
import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    key: { type: String, required: true },
    channel: { type: String, enum: ["email", "sms"], required: true },
    recipientHash: { type: String, required: true },
    state: {
      type: String,
      enum: [
        "pending",
        "sending",
        "accepted",
        "blocked",
        "uncertain",
        "canceled",
        "failed",
      ],
      default: "pending",
    },
    attempts: { type: Number, default: 0 },
    leaseToken: String,
    leaseUntil: Date,
    nextAttemptAt: { type: Date, default: Date.now },
    providerMessageId: String,
    lastErrorCode: String,
  },
  { timestamps: true },
);
schema.index(
  { business: 1, key: 1, channel: 1, recipientHash: 1 },
  { unique: true },
);
schema.index({ business: 1, createdAt: -1 });
schema.index({ state: 1, leaseUntil: 1 });
export default mongoose.models.StaffNotificationDelivery ||
  mongoose.model("StaffNotificationDelivery", schema);
