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
  },
  {
    timestamps: true,
  },
);

const Subscription =
  mongoose.models.Subscription ||
  mongoose.model("Subscription", SubscriptionSchema);

export default Subscription;
