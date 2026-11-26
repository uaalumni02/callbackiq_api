import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    completedAt: Date,
    collectionsErased: Number,
    recordsErased: Number,
    purgeAt: Date,
  },
  { versionKey: false },
);
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.models.TenantDeletionReceipt ||
  mongoose.model("TenantDeletionReceipt", schema);
