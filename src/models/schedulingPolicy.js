import mongoose from "mongoose";

const { Schema } = mongoose;

const SchedulingPolicySchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      unique: true,
      index: true,
    },
    customerRemindersEnabled: { type: Boolean, default: undefined },
    reminderHours: { type: [Number], default: undefined, validate: value => !value || (value.length > 0 && value.length <= 4 && value.every(hour => Number.isFinite(hour) && hour >= 1 && hour <= 168)) },
    postAppointmentFollowUpEnabled: { type: Boolean, default: undefined },
    postAppointmentFollowUpDelayHours: { type: Number, min: 1, max: 168, default: undefined },
    staffSmsEnabled: { type: Boolean, default: false },
    staffSmsPhone: { type: String, default: '', trim: true },
    approvalSmsEnabled: { type: Boolean, default: false },
    approvalSmsPhone: { type: String, default: '', trim: true },
    automaticConfirmationAuthorized: { type: Boolean, default: false },
    appointmentStyle: { type: String, enum: ['exact', 'arrival_window'], default: 'exact' },
    arrivalWindowMinutes: { type: Number, enum: [60, 120, 240], default: 120 },
    minimumNoticeMinutes: { type: Number, min: 0, max: 43200, default: 1440 },
    maximumAdvanceDays: { type: Number, min: 1, max: 730, default: 60 },
    slotIntervalMinutes: { type: Number, min: 5, max: 240, default: 30 },
    defaultDurationMinutes: { type: Number, min: 15, max: 1440, default: 90 },
    requireAddressBeforeBooking: { type: Boolean, default: true },
    requireServiceBeforeBooking: { type: Boolean, default: true },
    allowSameDayBooking: { type: Boolean, default: false },
    allowAfterHoursBooking: { type: Boolean, default: false },
    aiBookingConfirmationMode: {
      type: String,
      enum: ["auto", "manual"],
      default: "manual",
    },
    manualApprovalHoldMinutes: {
      type: Number,
      min: 5,
      max: 1440,
      default: 30,
    },
    customerCancellationAllowed: { type: Boolean, default: true },
    cancellationNoticeMinutes: { type: Number, min: 0, max: 43200, default: 1440 },
    confirmationMessageTemplate: {
      type: String,
      trim: true,
      maxlength: 1000,
      default:
        "Your appointment request has been received. A team member will confirm the date and time.",
    },
    cancellationMessageTemplate: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "Your cancellation request has been received.",
    },
    rescheduleMessageTemplate: {
      type: String,
      trim: true,
      maxlength: 1000,
      default:
        "Your reschedule request has been received. A team member will confirm the new time.",
    },
  },
  { timestamps: true },
);

const SchedulingPolicy =
  mongoose.models.SchedulingPolicy ||
  mongoose.model("SchedulingPolicy", SchedulingPolicySchema);

export default SchedulingPolicy;
