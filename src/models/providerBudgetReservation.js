import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    _id: { type: String },
    scope: { type: String, required: true },
    metric: { type: String, enum: ["voice", "sms", "ai"], required: true },
    state: { type: String, enum: ["reserved", "settled"], default: "reserved" },
    actualAmount: { type: Number, default: null },
    buckets: [String],
    amount: { type: Number, min: 1, required: true },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true },
);
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.models.ProviderBudgetReservation ||
  mongoose.model("ProviderBudgetReservation", schema);
