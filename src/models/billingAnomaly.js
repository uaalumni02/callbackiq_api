import mongoose from "mongoose";

const { Schema } = mongoose;

const BillingAnomalySchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      default: null,
      index: true,
    },
    type: {
      type: String,
      required: true,
      index: true,
    },
    severity: {
      type: String,
      enum: ["warning", "critical"],
      default: "critical",
      index: true,
    },
    status: {
      type: String,
      enum: ["open", "resolved"],
      default: "open",
      index: true,
    },
    stripeCustomerId: {
      type: String,
      default: "",
      index: true,
    },
    canonicalSubscriptionId: {
      type: String,
      default: "",
      index: true,
    },
    observedSubscriptionId: {
      type: String,
      default: "",
      index: true,
    },
    invoiceId: {
      type: String,
      default: "",
      index: true,
    },
    eventId: {
      type: String,
      default: "",
    },
    source: {
      type: String,
      default: "",
    },
    dedupeKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    details: {
      type: Schema.Types.Mixed,
      default: {},
    },
    occurrences: {
      type: Number,
      default: 0,
      min: 0,
    },
    firstSeenAt: {
      type: Date,
      default: Date.now,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

BillingAnomalySchema.index({ status: 1, severity: 1, lastSeenAt: -1 });
BillingAnomalySchema.index({ stripeCustomerId: 1, status: 1 });

const BillingAnomaly =
  mongoose.models.BillingAnomaly ||
  mongoose.model("BillingAnomaly", BillingAnomalySchema);

export default BillingAnomaly;
