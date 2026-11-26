import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    _id: { type: String },
    used: { type: Number, min: 0, default: 0 },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true },
);
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.models.ProviderBudgetCounter ||
  mongoose.model("ProviderBudgetCounter", schema);
