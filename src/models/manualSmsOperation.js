import mongoose from "mongoose";

const { Schema } = mongoose;

const ManualSmsOperationSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    lead: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    operationId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    state: {
      type: String,
      enum: [
        "created",
        "dispatching",
        "provider_accepted",
        "completed",
        "blocked",
        "failed",
        "reconciliation_required",
      ],
      default: "created",
      index: true,
    },
    to: { type: String, trim: true, required: true },
    body: { type: String, trim: true, required: true, maxlength: 1600 },
    bodyFingerprint: { type: String, required: true, maxlength: 64 },
    providerMessageId: { type: String, trim: true, default: "" },
    providerStatus: { type: String, trim: true, default: "" },
    message: { type: Schema.Types.ObjectId, ref: "Message", default: null },
    failureCode: { type: String, trim: true, maxlength: 160, default: "" },
    failureMessage: { type: String, trim: true, maxlength: 1000, default: "" },
    lastAttemptAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true },
);

ManualSmsOperationSchema.index(
  { business: 1, operationId: 1 },
  { unique: true },
);
ManualSmsOperationSchema.index(
  { state: 1, updatedAt: 1 },
  { name: "manual_sms_reconciliation_queue" },
);
ManualSmsOperationSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

const ManualSmsOperation =
  mongoose.models.ManualSmsOperation ||
  mongoose.model("ManualSmsOperation", ManualSmsOperationSchema);

export default ManualSmsOperation;
