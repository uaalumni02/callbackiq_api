import mongoose from "mongoose";
const { Schema } = mongoose;

const VoiceUsageLedgerSchema = new Schema(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    periodType: { type: String, enum: ["day", "month"], required: true },
    periodKey: { type: String, required: true },
    reservedSeconds: { type: Number, default: 0, min: 0 },
    completedSeconds: { type: Number, default: 0, min: 0 },
    openAiInputTokens: { type: Number, default: 0, min: 0 },
    openAiOutputTokens: { type: Number, default: 0, min: 0 },
    twilioEstimatedCostCents: { type: Number, default: 0, min: 0 },
    openAiEstimatedCostCents: { type: Number, default: 0, min: 0 },
    transferAttempts: { type: Number, default: 0, min: 0 },
    rejectedCalls: { type: Number, default: 0, min: 0 },
    lastSession: { type: Schema.Types.ObjectId, ref: "VoiceSession", default: null },
    thresholdAlertsSent: { type: [Number], default: [] },
  },
  { timestamps: true },
);

VoiceUsageLedgerSchema.index(
  { business: 1, periodType: 1, periodKey: 1 },
  { unique: true },
);

export default mongoose.model("VoiceUsageLedger", VoiceUsageLedgerSchema);
