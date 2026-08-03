import mongoose from "mongoose";
const { Schema } = mongoose;

const VoiceAbuseSignalSchema = new Schema(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    callerHash: { type: String, required: true, index: true },
    signalType: {
      type: String,
      enum: [
        "caller_velocity",
        "excessive_duration",
        "repeated_transfer",
        "silence_loop",
        "budget_rejection",
        "provider_cost_spike",
      ],
      required: true,
    },
    severity: { type: String, enum: ["low", "medium", "high", "critical"], default: "medium" },
    count: { type: Number, default: 1 },
    metadata: { type: Schema.Types.Mixed, default: {} },
    occurredAt: { type: Date, default: Date.now, index: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true },
);

VoiceAbuseSignalSchema.index({ business: 1, callerHash: 1, occurredAt: -1 });

export default mongoose.model("VoiceAbuseSignal", VoiceAbuseSignalSchema);
