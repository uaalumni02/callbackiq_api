import mongoose from "mongoose";

const { Schema } = mongoose;

const CommunicationRouteRateLimitSchema = new Schema(
  {
    keyHash: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
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

CommunicationRouteRateLimitSchema.index(
  { keyHash: 1, name: 1, windowStart: 1 },
  { unique: true },
);
CommunicationRouteRateLimitSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 },
);

const CommunicationRouteRateLimit =
  mongoose.models.CommunicationRouteRateLimit ||
  mongoose.model(
    "CommunicationRouteRateLimit",
    CommunicationRouteRateLimitSchema,
  );

export default CommunicationRouteRateLimit;
