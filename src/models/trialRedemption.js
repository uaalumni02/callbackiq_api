import mongoose from "mongoose";
const { Schema } = mongoose;

/*
 * One row per free trial ever granted.
 *
 * Uniqueness is enforced at the index level so a duplicate trial is
 * impossible even under concurrent requests. Each key is a separate
 * index because any one of them matching means the trial is spent:
 *
 * - owner:    same user account
 * - emailKey: same normalized email across new accounts
 * - phoneKey: same business phone across new accounts
 */
const TrialRedemptionSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: [true, "Business is required"],
      index: true,
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

TrialRedemptionSchema.index({ owner: 1 }, { unique: true });

TrialRedemptionSchema.index({ emailKey: 1 }, { unique: true });

TrialRedemptionSchema.index(
  { phoneKey: 1 },
  {
    unique: true,
    partialFilterExpression: { phoneKey: { $gt: "" } },
  },
);

const TrialRedemption =
  mongoose.models.TrialRedemption ||
  mongoose.model("TrialRedemption", TrialRedemptionSchema);

export default TrialRedemption;
