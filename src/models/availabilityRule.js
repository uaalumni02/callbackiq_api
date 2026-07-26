import mongoose from "mongoose";

const { Schema } = mongoose;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const TimeWindowSchema = new Schema(
  {
    startTime: {
      type: String,
      required: true,
      match: TIME_PATTERN,
    },
    endTime: {
      type: String,
      required: true,
      match: TIME_PATTERN,
    },
  },
  { _id: false },
);

const AvailabilityRuleSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    dayOfWeek: {
      type: Number,
      required: true,
      min: 0,
      max: 6,
    },
    enabled: {
      type: Boolean,
      default: false,
    },
    windows: {
      type: [TimeWindowSchema],
      default: [],
    },
    timezone: {
      type: String,
      default: "America/New_York",
      trim: true,
    },
    capacity: {
      type: Number,
      min: 1,
      max: 100,
      default: 1,
    },
  },
  { timestamps: true },
);

AvailabilityRuleSchema.pre("validate", function validateWindows() {
  const sorted = [...(this.windows || [])].sort((a, b) =>
    a.startTime.localeCompare(b.startTime),
  );

  for (let index = 0; index < sorted.length; index += 1) {
    const window = sorted[index];

    if (window.startTime >= window.endTime) {
      this.invalidate(
        "windows",
        "Availability window startTime must be before endTime",
      );
      return;
    }

    if (index > 0 && sorted[index - 1].endTime > window.startTime) {
      this.invalidate("windows", "Availability windows cannot overlap");
      return;
    }
  }

  this.windows = sorted;
});

AvailabilityRuleSchema.index(
  { business: 1, dayOfWeek: 1 },
  { unique: true },
);

const AvailabilityRule =
  mongoose.models.AvailabilityRule ||
  mongoose.model("AvailabilityRule", AvailabilityRuleSchema);

export default AvailabilityRule;
