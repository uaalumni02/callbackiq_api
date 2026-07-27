import mongoose from "mongoose";

const { Schema } = mongoose;

const AutomationJobSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    workflow: {
      type: Schema.Types.ObjectId,
      ref: "AutomationWorkflow",
      required: true,
    },
    lead: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },
    appointment: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
    },
    stepIndex: { type: Number, min: 0, default: 0 },
    action: { type: String, trim: true, required: true },
    template: { type: String, trim: true, required: true, maxlength: 1600 },
    status: {
      type: String,
      enum: ["scheduled", "processing", "completed", "canceled", "failed"],
      default: "scheduled",
    },
    executeAt: { type: Date, required: true },
    attemptNumber: { type: Number, min: 1, default: 1 },
    idempotencyKey: { type: String, trim: true, required: true },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: String, trim: true, default: null },
    completedAt: { type: Date, default: null },
    canceledAt: { type: Date, default: null },
    failureReason: { type: String, trim: true, default: "", maxlength: 2000 },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

AutomationJobSchema.index(
  { business: 1, idempotencyKey: 1 },
  { unique: true },
);
AutomationJobSchema.index({ status: 1, executeAt: 1, lockedAt: 1 });
AutomationJobSchema.index({ business: 1, conversation: 1, status: 1 });
AutomationJobSchema.index({ business: 1, lead: 1, status: 1 });

const AutomationJob =
  mongoose.models.AutomationJob ||
  mongoose.model("AutomationJob", AutomationJobSchema);

export default AutomationJob;
