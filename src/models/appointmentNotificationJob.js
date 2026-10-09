import mongoose from "mongoose";

const { Schema } = mongoose;

const AppointmentNotificationJobSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    appointment: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      required: true,
    },
    lead: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },
    key: { type: String, required: true, trim: true, maxlength: 80 },
    type: {
      type: String,
      enum: ["reminder", "follow_up", "change_notice"],
      required: true,
    },
    hoursBefore: { type: Number, default: null },
    body: { type: String, trim: true, maxlength: 1600, default: "" },
    scheduledFor: { type: Date, required: true },
    status: {
      type: String,
      enum: ["scheduled", "processing", "sent", "canceled", "failed"],
      default: "scheduled",
    },
    attempts: { type: Number, min: 0, default: 0 },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: String, trim: true, default: "" },
    sentAt: { type: Date, default: null },
    canceledAt: { type: Date, default: null },
    resolutionAt: { type: Date, default: null },
    resolutionReason: { type: String, default: '' },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    failureCheckedAt: { type: Date, default: null },
    deliveryStatus: { type: String, default: '' },
    deliveryErrorMessage: { type: String, default: '' },
    providerMessageId: { type: String, trim: true, default: "" },
    failureReason: { type: String, trim: true, maxlength: 1000, default: "" },
  },
  { timestamps: true },
);

AppointmentNotificationJobSchema.index(
  { business: 1, appointment: 1, key: 1 },
  { unique: true },
);
AppointmentNotificationJobSchema.index({ business: 1, providerMessageId: 1 });
AppointmentNotificationJobSchema.index({
  status: 1,
  scheduledFor: 1,
  lockedAt: 1,
});

AppointmentNotificationJobSchema.index({ resolutionAt: 1, status: 1, failureCheckedAt: 1, _id: 1 });
AppointmentNotificationJobSchema.index({ resolutionAt: 1, deliveryStatus: 1, sentAt: 1 });

const AppointmentNotificationJob =
  mongoose.models.AppointmentNotificationJob ||
  mongoose.model(
    "AppointmentNotificationJob",
    AppointmentNotificationJobSchema,
  );

export default AppointmentNotificationJob;
