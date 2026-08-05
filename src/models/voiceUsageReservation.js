import mongoose from "mongoose";

const { Schema } = mongoose;

const VoiceUsageReservationSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    session: {
      type: Schema.Types.ObjectId,
      ref: "VoiceSession",
      required: true,
      index: true,
    },
    reservationKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 220,
      unique: true,
    },
    requestedSeconds: { type: Number, min: 1, required: true },
    state: {
      type: String,
      enum: ["preparing", "active", "committed", "released", "rejected", "releasing"],
      default: "preparing",
      index: true,
    },
    dayPeriodKey: { type: String, required: true },
    monthPeriodKey: { type: String, required: true },
    reservedPeriodTypes: [{ type: String, enum: ["day", "month"] }],
    ownerToken: { type: String, trim: true, default: "" },
    leaseExpiresAt: { type: Date, required: true, index: true },
    actualSeconds: { type: Number, min: 0, default: 0 },
    releaseReason: { type: String, trim: true, maxlength: 300, default: "" },
    committedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true },
);

VoiceUsageReservationSchema.index(
  { state: 1, leaseExpiresAt: 1 },
  { name: "voice_usage_reservation_recovery" },
);
VoiceUsageReservationSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

const VoiceUsageReservation =
  mongoose.models.VoiceUsageReservation ||
  mongoose.model("VoiceUsageReservation", VoiceUsageReservationSchema);

export default VoiceUsageReservation;
