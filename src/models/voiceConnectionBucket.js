import mongoose from "mongoose";

const { Schema } = mongoose;

const VoiceConnectionLeaseSchema = new Schema(
  {
    leaseId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { _id: false },
);

const VoiceConnectionBucketSchema = new Schema(
  {
    ipHash: { type: String, required: true, unique: true, maxlength: 64 },
    leases: { type: [VoiceConnectionLeaseSchema], default: [] },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true },
);

VoiceConnectionBucketSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

const VoiceConnectionBucket =
  mongoose.models.VoiceConnectionBucket ||
  mongoose.model("VoiceConnectionBucket", VoiceConnectionBucketSchema);

export default VoiceConnectionBucket;
