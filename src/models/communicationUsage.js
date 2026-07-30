import mongoose from "mongoose";

const { Schema } = mongoose;

const CommunicationUsageSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    scope: {
      type: String,
      enum: ["business", "customer"],
      required: true,
    },
    scopeKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    metric: {
      type: String,
      enum: ["sms_outbound", "ai_operation"],
      required: true,
    },
    window: {
      type: String,
      enum: ["hour", "day"],
      required: true,
    },
    windowStart: {
      type: Date,
      required: true,
    },
    count: {
      type: Number,
      min: 0,
      default: 0,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

CommunicationUsageSchema.index(
  {
    business: 1,
    scope: 1,
    scopeKey: 1,
    metric: 1,
    window: 1,
    windowStart: 1,
  },
  { unique: true },
);
CommunicationUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const CommunicationUsage =
  mongoose.models.CommunicationUsage ||
  mongoose.model("CommunicationUsage", CommunicationUsageSchema);

export default CommunicationUsage;
