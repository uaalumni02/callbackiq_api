// CALLBACKIQ_MARKETING_ATTRIBUTION_V1
import mongoose from "mongoose";
import { normalizePhoneToE164 } from "../voice/voicePhone.service.js";

const { Schema } = mongoose;

const TrackingNumberSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    marketingSource: {
      type: Schema.Types.ObjectId,
      ref: "MarketingSource",
      default: null,
      index: true,
    },
    kind: {
      type: String,
      enum: ["primary", "marketing"],
      default: "marketing",
      required: true,
    },
    isPrimary: { type: Boolean, default: false, index: true },
    phoneNumber: {
      type: String,
      trim: true,
      required: true,
    },
    phoneLookup: {
      type: String,
      trim: true,
      required: true,
      select: false,
    },
    provider: {
      type: String,
      enum: ["twilio"],
      default: "twilio",
    },
    providerSid: {
      type: String,
      trim: true,
      default: "",
      select: false,
    },
    status: {
      type: String,
      enum: ["pending", "active", "failed", "released"],
      default: "pending",
      index: true,
    },
    callHandlingMode: {
      type: String,
      enum: ["forward", "overflow", "ai"],
      default: "forward",
      index: true,
    },
    forwardingPhone: { type: String, trim: true, default: "" },
    voiceEnabled: { type: Boolean, default: true },
    smsEnabled: {
      type: Boolean,
      default: function defaultSmsCapability() {
        return this.kind === "marketing" ? false : true;
      },
    },
    smsRecoveryEnabled: { type: Boolean, default: false },
    voiceAiEnabled: { type: Boolean, default: false },
    recordingEnabled: { type: Boolean, default: false },
    senderAttached: { type: Boolean, default: false },
    smsReady: { type: Boolean, default: false },
    assignedAt: { type: Date, default: Date.now },
    activatedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    lastError: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
  },
  { timestamps: true },
);

TrackingNumberSchema.pre("validate", function normalizeNumber() {
  const normalized = normalizePhoneToE164(this.phoneNumber);
  if (!normalized) {
    this.invalidate("phoneNumber", "Tracking number must be valid E.164.");
    return;
  }
  this.phoneNumber = normalized;
  this.phoneLookup =
    this.status === "released"
      ? `released:${this._id}:${normalized}`
      : normalized;
});

TrackingNumberSchema.index({ phoneLookup: 1 }, { unique: true });
TrackingNumberSchema.index(
  { providerSid: 1 },
  {
    unique: true,
    partialFilterExpression: { providerSid: { $gt: "" } },
  },
);
TrackingNumberSchema.index({
  business: 1,
  marketingSource: 1,
  status: 1,
  createdAt: -1,
});
TrackingNumberSchema.index({
  business: 1,
  isPrimary: 1,
  status: 1,
});

const TrackingNumber =
  mongoose.models.TrackingNumber ||
  mongoose.model("TrackingNumber", TrackingNumberSchema);

export default TrackingNumber;
