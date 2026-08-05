import mongoose from "mongoose";

const { Schema } = mongoose;

const SmsProcessingJobSchema = new Schema(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    inboundMessage: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      required: true,
      unique: true,
      index: true,
    },
    conversation: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
    lead: { type: Schema.Types.ObjectId, ref: "Lead", required: true },
    providerMessageId: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["queued", "processing", "retry", "completed", "dead"],
      default: "queued",
      index: true,
    },
    priority: { type: Number, min: 0, max: 100, default: 50 },
    attemptCount: { type: Number, min: 0, default: 0 },
    maxAttempts: { type: Number, min: 1, max: 20, default: 5 },
    availableAt: { type: Date, default: Date.now, index: true },
    leaseToken: { type: String, trim: true, default: "" },
    leaseExpiresAt: { type: Date, default: null, index: true },
    processingStartedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    deadAt: { type: Date, default: null },
    lastError: { type: String, trim: true, maxlength: 4000, default: "" },
    result: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

SmsProcessingJobSchema.index({
  status: 1,
  availableAt: 1,
  priority: -1,
  createdAt: 1,
});
SmsProcessingJobSchema.index({ status: 1, leaseExpiresAt: 1 });

const SmsProcessingJob =
  mongoose.models.SmsProcessingJob ||
  mongoose.model("SmsProcessingJob", SmsProcessingJobSchema);

export default SmsProcessingJob;
