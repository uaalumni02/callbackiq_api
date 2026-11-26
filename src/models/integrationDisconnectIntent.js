import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    provider: { type: String, enum: ["google_calendar"], required: true },
    fingerprint: { type: String, required: true },
    state: {
      type: String,
      enum: ["pending", "processing", "completed"],
      default: "pending",
    },
    accessTokenEncrypted: { type: String, select: false, default: "" },
    refreshTokenEncrypted: { type: String, select: false, default: "" },
    watchChannelId: { type: String, default: "" },
    watchResourceId: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    leaseToken: String,
    leaseUntil: Date,
    lastErrorCode: { type: String, default: "" },
    completedAt: Date,
    purgeAt: Date,
  },
  { timestamps: true },
);
schema.index({ business: 1, provider: 1, fingerprint: 1 }, { unique: true });
schema.index({ state: 1, nextAttemptAt: 1, leaseUntil: 1, _id: 1 });
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.models.IntegrationDisconnectIntent ||
  mongoose.model("IntegrationDisconnectIntent", schema);
