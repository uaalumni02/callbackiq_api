import mongoose from "mongoose";
const { Schema } = mongoose;

const BillingEventSchema = new Schema(
  {
    provider: {
      type: String,
      enum: ["stripe"],
      default: "stripe",
      required: true,
    },
    providerEventId: {
      type: String,
      required: true,
      trim: true,
    },
    eventType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    livemode: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["received", "processing", "processed", "ignored", "failed"],
      default: "received",
      index: true,
    },
    attempts: {
      type: Number,
      default: 1,
      min: 1,
    },
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      default: null,
      index: true,
    },
    resourceId: {
      type: String,
      trim: true,
      default: "",
    },
    requestId: {
      type: String,
      trim: true,
      default: "",
    },
    failureReason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    receivedAt: {
      type: Date,
      default: Date.now,
    },
    processingStartedAt: {
      type: Date,
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

BillingEventSchema.index(
  { provider: 1, providerEventId: 1 },
  { unique: true },
);
BillingEventSchema.index({ business: 1, createdAt: -1 });
BillingEventSchema.index({ status: 1, createdAt: -1 });

const BillingEvent =
  mongoose.models.BillingEvent ||
  mongoose.model("BillingEvent", BillingEventSchema);

export default BillingEvent;
