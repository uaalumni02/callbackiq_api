import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    stripeCustomerId: String,
    stripeSubscriptionId: String,
    plan: String,
    priceMonthly: Number,
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
    closedAt: Date,
    purgeAt: Date,
  },
  { versionKey: false },
);
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.models.RetainedBillingRecord ||
  mongoose.model("RetainedBillingRecord", schema);
