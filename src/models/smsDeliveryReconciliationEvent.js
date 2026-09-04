import mongoose from "mongoose";

const { Schema } = mongoose;

const SmsDeliveryReconciliationEventSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    eventKey: { type: String, required: true, trim: true },
    providerMessageId: { type: String, required: true, trim: true },
    providerStatus: { type: String, required: true, trim: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ["pending", "processing", "retry", "applied", "dead"],
      default: "pending",
      required: true,
    },
    attemptCount: { type: Number, min: 0, default: 0 },
    maxAttempts: { type: Number, min: 1, default: 20 },
    availableAt: { type: Date, default: Date.now },
    leaseToken: { type: String, trim: true, default: "" },
    leaseExpiresAt: { type: Date, default: null },
    processingStartedAt: { type: Date, default: null },
    appliedAt: { type: Date, default: null },
    deadAt: { type: Date, default: null },
    lastError: { type: String, trim: true, maxlength: 1000, default: "" },
  },
  { timestamps: true },
);

SmsDeliveryReconciliationEventSchema.index(
  { business: 1, eventKey: 1 },
  { unique: true },
);
SmsDeliveryReconciliationEventSchema.index({
  status: 1,
  availableAt: 1,
  leaseExpiresAt: 1,
  createdAt: 1,
});

const SmsDeliveryReconciliationEvent =
  mongoose.models.SmsDeliveryReconciliationEvent ||
  mongoose.model(
    "SmsDeliveryReconciliationEvent",
    SmsDeliveryReconciliationEventSchema,
  );

export default SmsDeliveryReconciliationEvent;
