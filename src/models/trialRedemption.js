import mongoose from "mongoose";

const { Schema } = mongoose;

/*
 * One row per free trial ever granted.
 *
 * Uniqueness is enforced at the index level so a duplicate trial is
 * impossible even under concurrent requests. Each identity key has a
 * separate unique index because a match on any one means the trial is spent.
 */
const TrialRedemptionSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: [true, "Business is required"],
    },

    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Owner is required"],
    },

    emailKey: {
      type: String,
      required: [true, "Email key is required"],
      trim: true,
      lowercase: true,
    },

    phoneKey: {
      type: String,
      default: "",
      trim: true,
    },

    stripeSubscriptionId: {
      type: String,
      trim: true,
      default: "",
    },
    grantedBy: {
      type: String,
      enum: ["self", "admin"],
      default: "self",
    },

    redeemedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

TrialRedemptionSchema.index(
  {
    owner: 1,
  },
  {
    unique: true,
  },
);

TrialRedemptionSchema.index(
  {
    emailKey: 1,
  },
  {
    unique: true,
  },
);

TrialRedemptionSchema.index(
  {
    phoneKey: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      phoneKey: {
        $gt: "",
      },
    },
  },
);

/*
 * Supports business-level cleanup and audit history sorted newest first.
 */
TrialRedemptionSchema.index(
  {
    business: 1,
    redeemedAt: -1,
  },
  {
    name: "trial_redemption_business_recent",
  },
);

const TrialRedemption =
  mongoose.models.TrialRedemption ||
  mongoose.model("TrialRedemption", TrialRedemptionSchema);

export default TrialRedemption;
