import mongoose from "mongoose";

const { Schema } = mongoose;

const TrialExtensionGrantSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    subscription: {
      type: Schema.Types.ObjectId,
      ref: "Subscription",
      required: true,
    },
    grantedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    days: {
      type: Number,
      min: 1,
      max: 14,
      required: true,
    },
    reason: {
      type: String,
      trim: true,
      maxlength: 500,
      required: true,
    },
    previousTrialEndsAt: {
      type: Date,
      required: true,
    },
    newTrialEndsAt: {
      type: Date,
      required: true,
    },
    stripeSubscriptionId: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true },
);

TrialExtensionGrantSchema.index({ business: 1, createdAt: -1 });

const TrialExtensionGrant =
  mongoose.models.TrialExtensionGrant ||
  mongoose.model("TrialExtensionGrant", TrialExtensionGrantSchema);

export default TrialExtensionGrant;
