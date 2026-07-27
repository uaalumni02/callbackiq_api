import mongoose from "mongoose";

const { Schema } = mongoose;

const WorkflowStepSchema = new Schema(
  {
    delayMinutes: { type: Number, min: 0, required: true },
    action: {
      type: String,
      enum: ["send_sms", "create_alert", "mark_for_review"],
      default: "send_sms",
      required: true,
    },
    template: { type: String, trim: true, required: true, maxlength: 1600 },
  },
  { _id: true },
);

const AutomationWorkflowSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    name: { type: String, trim: true, required: true, maxlength: 120 },
    trigger: {
      type: String,
      enum: [
        "missed_call_no_response",
        "incomplete_qualification",
        "appointment_offered_not_selected",
        "canceled_appointment_recovery",
      ],
      required: true,
    },
    enabled: { type: Boolean, default: true },
    steps: { type: [WorkflowStepSchema], default: [] },
    maximumAttempts: { type: Number, min: 1, max: 10, default: 3 },
    quietHoursStart: { type: String, default: "20:00" },
    quietHoursEnd: { type: String, default: "08:00" },
    minimumIntervalMinutes: { type: Number, min: 15, default: 120 },
    allowedDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
    templateApprovalRequired: { type: Boolean, default: true },
    templatesApproved: { type: Boolean, default: false },
  },
  { timestamps: true },
);

AutomationWorkflowSchema.index({ business: 1, trigger: 1, enabled: 1 });
AutomationWorkflowSchema.index(
  { business: 1, name: 1 },
  { unique: true },
);

const AutomationWorkflow =
  mongoose.models.AutomationWorkflow ||
  mongoose.model("AutomationWorkflow", AutomationWorkflowSchema);

export default AutomationWorkflow;
