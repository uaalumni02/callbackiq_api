import mongoose from "mongoose";

const { Schema } = mongoose;
const START_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const END_TIME_PATTERN = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

const toMinutes = (value) => {
  if (value === "24:00") return 1440;
  const [hours, minutes] = String(value || "").split(":").map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes)
    ? hours * 60 + minutes
    : null;
};

const windowSegments = (window) => {
  if (window?.allDay) return [[0, 1440]];
  const start = toMinutes(window?.startTime);
  const end = toMinutes(window?.endTime);
  if (start == null || end == null || start === end) return [];
  return end > start ? [[start, end]] : [[start, 1440], [0, end]];
};

const overlaps = (left, right) =>
  windowSegments(left).some(([leftStart, leftEnd]) =>
    windowSegments(right).some(
      ([rightStart, rightEnd]) => leftStart < rightEnd && rightStart < leftEnd,
    ),
  );

const TimeWindowSchema = new Schema(
  {
    startTime: {
      type: String,
      required() {
        return this.allDay !== true;
      },
      default: "00:00",
      match: START_TIME_PATTERN,
    },
    endTime: {
      type: String,
      required() {
        return this.allDay !== true;
      },
      default: "24:00",
      match: END_TIME_PATTERN,
    },
    allDay: { type: Boolean, default: false },
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
    dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
    enabled: { type: Boolean, default: false },
    windows: { type: [TimeWindowSchema], default: [] },
    timezone: { type: String, default: "America/New_York", trim: true },
    capacity: { type: Number, min: 1, max: 100, default: 1 },
  },
  { timestamps: true },
);

AvailabilityRuleSchema.pre("validate", function validateWindows() {
  const windows = [...(this.windows || [])];

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    if (!window?.allDay && toMinutes(window.startTime) === toMinutes(window.endTime)) {
      this.invalidate(
        "windows",
        "Use allDay for a 24-hour window; startTime and endTime cannot be equal.",
      );
      return;
    }
    for (let otherIndex = index + 1; otherIndex < windows.length; otherIndex += 1) {
      if (overlaps(window, windows[otherIndex])) {
        this.invalidate("windows", "Availability windows cannot overlap.");
        return;
      }
    }
  }

  this.windows = windows.sort((left, right) => {
    if (left.allDay) return -1;
    if (right.allDay) return 1;
    return String(left.startTime).localeCompare(String(right.startTime));
  });
});

AvailabilityRuleSchema.index(
  { business: 1, dayOfWeek: 1 },
  { unique: true },
);

const AvailabilityRule =
  mongoose.models.AvailabilityRule ||
  mongoose.model("AvailabilityRule", AvailabilityRuleSchema);

export default AvailabilityRule;
