import mongoose from "mongoose";

const { Schema } = mongoose;

const VoiceUsageReconciliationSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    session: {
      type: Schema.Types.ObjectId,
      ref: "VoiceSession",
      required: true,
      unique: true,
    },
    state: {
      type: String,
      enum: ["processing", "completed", "failed"],
      default: "processing",
      index: true,
    },
    ownerToken: { type: String, trim: true, required: true },
    leaseExpiresAt: { type: Date, required: true, index: true },
    actualSeconds: { type: Number, min: 0, default: 0 },
    reservedSecondsReleased: { type: Number, min: 0, default: 0 },
    failureCode: { type: String, trim: true, maxlength: 160, default: "" },
    failureMessage: { type: String, trim: true, maxlength: 1000, default: "" },
    completedAt: { type: Date, default: null },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true },
);

VoiceUsageReconciliationSchema.index(
  { state: 1, leaseExpiresAt: 1 },
  { name: "voice_usage_reconciliation_recovery" },
);
VoiceUsageReconciliationSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

const VoiceUsageReconciliation =
  mongoose.models.VoiceUsageReconciliation ||
  mongoose.model("VoiceUsageReconciliation", VoiceUsageReconciliationSchema);

export default VoiceUsageReconciliation;
