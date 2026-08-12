import mongoose from "mongoose";
const { Schema } = mongoose;

import * as validate from "../helpers/model/subscription.js";

const SubscriptionSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: [true, "Business is required"],
      unique: true,
    },

    stripeCustomerId: {
      type: String,
      default: "",
      index: true,
    },

    stripeSubscriptionId: {
      type: String,
      default: "",
      index: true,
    },

    plan: {
      type: String,
      enum: ["starter", "pro", "agency"],
      default: "pro",
      validate: [validate.isValidPlan, "Invalid subscription plan"],
    },

    status: {
      type: String,
      enum: [
        "incomplete",
        "incomplete_expired",
        "trialing",
        "active",
        "expired",
        "past_due",
        "canceled",
        "unpaid",
        "paused",
        "none",
      ],
      default: "none",
      validate: [
        validate.isValidSubscriptionStatus,
        "Invalid subscription status",
      ],
    },

    trialStartedAt: {
      type: Date,
      default: null,
    },

    trialEndsAt: {
      type: Date,
      default: null,
    },

    // Permanent record that this business has consumed its free trial.
    // Never cleared by trial expiry, cancellation, or downgrade.
    trialUsedAt: {
      type: Date,
      default: null,
    },

    trialCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Set by an admin to allow one additional trial. Cleared on redemption.
    trialOverrideGrantedAt: {
      type: Date,
      default: null,
    },

    isActive: {
      type: Boolean,
      default: false,
    },

    aiEnabled: {
      type: Boolean,
      default: true,
    },

    priceMonthly: {
      type: Number,
      default: 199,
    },

    currentPeriodStart: {
      type: Date,
      default: null,
    },

    currentPeriodEnd: {
      type: Date,
      default: null,
    },

    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
    },

    checkoutSessionId: {
      type: String,
      default: "",
    },

    latestInvoiceId: {
      type: String,
      default: "",
    },

    lastPaymentStatus: {
      type: String,
      default: "",
    },
    trialNumberReleaseAt: {
      type: Date,
      default: null,
    },
    trialWelcomeSentAt: {
      type: Date,
      default: null,
    },
    trialReminder3dSentAt: {
      type: Date,
      default: null,
    },
    trialReminder1dSentAt: {
      type: Date,
      default: null,
    },
    trialExpiredNotifiedAt: {
      type: Date,
      default: null,
    },
    trialNumberReleasedNotifiedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

/*
 * Supports finding trialing subscriptions that have reached their
 * expiration date.
 */
SubscriptionSchema.index({
  status: 1,
  trialEndsAt: 1,
});

/*
 * Supports billing jobs that inspect active, canceled, or past-due
 * subscriptions by the end of their current billing period.
 */
SubscriptionSchema.index({
  status: 1,
  currentPeriodEnd: 1,
});

const Subscription =
  mongoose.models.Subscription ||
  mongoose.model("Subscription", SubscriptionSchema);

export default Subscription;
