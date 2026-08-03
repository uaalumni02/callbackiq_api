import mongoose from "mongoose";

const { Schema } = mongoose;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const START_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const END_TIME_PATTERN = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

const ExceptionWindowSchema = new Schema(
  {
    startTime: { type: String, default: "00:00", match: START_TIME_PATTERN },
    endTime: { type: String, default: "24:00", match: END_TIME_PATTERN },
    allDay: { type: Boolean, default: false },
  },
  { _id: false },
);

const AvailabilityExceptionSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    date: { type: String, required: true, match: DATE_PATTERN, index: true },
    type: {
      type: String,
      enum: [
        "holiday",
        "closure",
        "special_hours",
        "fully_booked",
        "technician_meeting",
        "emergency_only",
      ],
      required: true,
    },
    name: { type: String, trim: true, maxlength: 120, default: "" },
    allDay: { type: Boolean, default: true },
    windows: { type: [ExceptionWindowSchema], default: [] },
    capacity: { type: Number, min: 0, max: 100, default: 0 },
    reason: { type: String, trim: true, maxlength: 500, default: "" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

AvailabilityExceptionSchema.pre("validate", function validateSpecialHours() {
  if (this.type !== "special_hours") return;
  if (!this.windows?.length) {
    this.invalidate("windows", "Special hours require at least one time window.");
  }
});

AvailabilityExceptionSchema.index({ business: 1, date: 1, active: 1 });

const AvailabilityException =
  mongoose.models.AvailabilityException ||
  mongoose.model("AvailabilityException", AvailabilityExceptionSchema);

export default AvailabilityException;
