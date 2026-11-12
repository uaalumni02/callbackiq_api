import mongoose from 'mongoose';

/** Integer revision, private provider SID, and no subdocument identity. */
const TrackingNumberSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ["twilio"], default: "twilio" },
    status: {
      type: String,
      enum: ["unassigned", "assigned", "verified", "active"],
      default: "unassigned",
      index: true,
    },
    providerSid: { type: String, trim: true, default: "", select: false },
    revision: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
    assignedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    activatedAt: { type: Date, default: null },
    lastError: { type: String, trim: true, maxlength: 1000, default: "" },
    updatedAt: { type: Date, default: null },
  },
  { _id: false },
);

export default TrackingNumberSchema;
