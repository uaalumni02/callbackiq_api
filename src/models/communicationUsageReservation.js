import mongoose from "mongoose";

const { Schema } = mongoose;

const CommunicationUsageReservationSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    operationKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 240,
      unique: true,
    },
    metric: {
      type: String,
      enum: ["sms_outbound", "ai_operation"],
      required: true,
    },
    amount: { type: Number, min: 1, required: true },
    counterIds: [{ type: Schema.Types.ObjectId, ref: "CommunicationUsage" }],
    state: {
      type: String,
      enum: ["pending", "committed", "released", "uncertain", "releasing"],
      default: "pending",
      index: true,
    },
    ownerToken: { type: String, trim: true, maxlength: 160, default: "" },
    providerOperationId: { type: String, trim: true, default: "" },
    providerStatus: { type: String, trim: true, default: "" },
    // Persisted before the provider call. An expired lease after this point
    // cannot prove that a customer text was never accepted.
    providerDispatchStartedAt: { type: Date, default: null },
    source: { type: String, trim: true, maxlength: 100, default: "" },
    releaseReason: { type: String, trim: true, maxlength: 300, default: "" },
    leaseExpiresAt: { type: Date, required: true, index: true },
    committedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true },
);

CommunicationUsageReservationSchema.index(
  { state: 1, leaseExpiresAt: 1 },
  { name: "communication_usage_reservation_recovery" },
);
CommunicationUsageReservationSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

const CommunicationUsageReservation =
  mongoose.models.CommunicationUsageReservation ||
  mongoose.model(
    "CommunicationUsageReservation",
    CommunicationUsageReservationSchema,
  );

export default CommunicationUsageReservation;
