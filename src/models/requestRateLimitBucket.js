// CALLBACKIQ_PRODUCTION_HARDENING_V1
import mongoose from "mongoose";

const requestRateLimitBucketSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    count: { type: Number, required: true, default: 0, min: 0 },
    expiresAt: { type: Date, required: true },
  },
  {
    collection: "request_rate_limit_buckets",
    timestamps: false,
    versionKey: false,
  },
);

requestRateLimitBucketSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "expires_at_ttl" },
);

const RequestRateLimitBucket =
  mongoose.models.RequestRateLimitBucket ||
  mongoose.model("RequestRateLimitBucket", requestRateLimitBucketSchema);

export default RequestRateLimitBucket;
