import mongoose from "mongoose";

const { Schema } = mongoose;

const VoiceLeaseSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    sessionId: { type: Schema.Types.ObjectId, ref: "VoiceSession", default: null },
    acquiredAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { _id: false },
);

const VoiceCapacitySchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      unique: true,
      index: true,
    },
    leases: { type: [VoiceLeaseSchema], default: [] },
  },
  { timestamps: true },
);

const VoiceCapacity =
  mongoose.models.VoiceCapacity ||
  mongoose.model("VoiceCapacity", VoiceCapacitySchema);

export default VoiceCapacity;
