import mongoose from "mongoose";

const { Schema } = mongoose;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const ExceptionWindowSchema = new Schema(
  {
    startTime: { type: String, required: true, match: TIME_PATTERN },
    endTime: { type: String, required: true, match: TIME_PATTERN },
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
    date: {
      type: String,
      required: true,
      match: DATE_PATTERN,
      index: true,
    },
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
    name: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    allDay: {
      type: Boolean,
      default: true,
    },
    windows: {
      type: [ExceptionWindowSchema],
      default: [],
    },
    capacity: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    reason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

AvailabilityExceptionSchema.index({ business: 1, date: 1, active: 1 });

const AvailabilityException =
  mongoose.models.AvailabilityException ||
  mongoose.model("AvailabilityException", AvailabilityExceptionSchema);

export default AvailabilityException;
