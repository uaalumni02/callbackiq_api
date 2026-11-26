import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      unique: true,
    },
    limits: { type: mongoose.Schema.Types.Mixed, default: {} },
    reason: { type: String, required: true, maxlength: 500 },
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);
export default mongoose.models.ProviderBudgetOverride ||
  mongoose.model("ProviderBudgetOverride", schema);
