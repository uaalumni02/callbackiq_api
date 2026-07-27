import mongoose from "mongoose";

const { Schema } = mongoose;

const ExternalRecordMappingSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    provider: { type: String, trim: true, required: true },
    localModel: { type: String, trim: true, required: true },
    localId: { type: Schema.Types.ObjectId, required: true },
    externalType: { type: String, trim: true, required: true },
    externalId: { type: String, trim: true, required: true },
    lastSyncedAt: { type: Date, default: null },
    syncStatus: {
      type: String,
      enum: ["pending", "synced", "failed"],
      default: "pending",
    },
    syncError: { type: String, trim: true, default: "", maxlength: 2000 },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

ExternalRecordMappingSchema.index(
  { business: 1, provider: 1, localModel: 1, localId: 1, externalType: 1 },
  { unique: true },
);
ExternalRecordMappingSchema.index(
  { business: 1, provider: 1, externalType: 1, externalId: 1 },
  { unique: true },
);

const ExternalRecordMapping =
  mongoose.models.ExternalRecordMapping ||
  mongoose.model("ExternalRecordMapping", ExternalRecordMappingSchema);

export default ExternalRecordMapping;
