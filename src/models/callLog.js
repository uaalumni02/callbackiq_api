import mongoose from "mongoose";
const { Schema } = mongoose;

import * as validate from "../helpers/model/callLog.js";

const CallLogSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },

    lead: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },

    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },

    // CALLBACKIQ_MARKETING_ATTRIBUTION_V1: attribution is captured when the phone rings, before outcome is known.
    marketingSource: {
      type: Schema.Types.ObjectId,
      ref: "MarketingSource",
      default: null,
      index: true,
    },
    trackingNumber: {
      type: Schema.Types.ObjectId,
      ref: "TrackingNumber",
      default: null,
      index: true,
    },
    attribution: {
      sourceId: { type: String, trim: true, default: "" },
      sourceName: { type: String, trim: true, default: "" },
      channel: { type: String, trim: true, default: "" },
      campaign: { type: String, trim: true, default: "" },
      trackingNumberId: { type: String, trim: true, default: "" },
      trackingNumber: { type: String, trim: true, default: "" },
    },

    from: {
      type: String,
      required: true,
      trim: true,
      validate: [validate.isValidPhone, "Invalid caller phone number"],
    },

    to: {
      type: String,
      required: true,
      trim: true,
      validate: [validate.isValidPhone, "Invalid receiving phone number"],
    },

    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      default: "inbound",
      validate: [validate.isValidDirection, "Invalid call direction"],
    },

    status: {
      type: String,
      enum: ["answered", "missed", "voicemail", "failed", "busy", "no_answer"],
      default: "missed",
      validate: [validate.isValidStatus, "Invalid call status"],
    },

    durationSeconds: {
      type: Number,
      default: 0,
      min: 0,
    },

    provider: {
      type: String,
      enum: ["manual", "twilio", "system"],
      default: "manual",
    },

    /*
     * Twilio Call SID.
     *
     * The existing providerCallId name is retained so historical data and
     * current controller code do not require a rename migration.
     */
    providerCallId: {
      type: String,
      trim: true,
      default: "",
    },

    recordingUrl: {
      type: String,
      trim: true,
      default: "",
    },

    transcription: {
      type: String,
      trim: true,
      default: "",
    },

    missedCallTextSent: {
      type: Boolean,
      default: false,
    },

    missedCallTextDelivered: { type: Boolean, default: false },
    smsProviderMessageId: { type: String, trim: true, default: "" },
    smsDeliveryStatus: { type: String, trim: true, default: "" },
    smsDeliveryErrorCode: { type: String, trim: true, default: "" },
    smsDeliveryErrorMessage: { type: String, trim: true, maxlength: 1000, default: "" },
    smsSegmentCount: { type: Number, min: 0, default: 0 },
    smsDeliveredAt: { type: Date, default: null },
    smsFailedAt: { type: Date, default: null },
    smsDeliveryEvents: {
      type: [
        {
          providerStatus: { type: String, trim: true, default: "" },
          canonicalStatus: { type: String, trim: true, default: "" },
          errorCode: { type: String, trim: true, default: "" },
          applied: { type: Boolean, default: false },
          conflict: { type: Boolean, default: false },
          receivedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    providerStatusEvents: {
      type: [
        {
          providerStatus: { type: String, trim: true, default: "" },
          canonicalStatus: { type: String, trim: true, default: "" },
          durationSeconds: { type: Number, min: 0, default: 0 },
          applied: { type: Boolean, default: false },
          conflict: { type: Boolean, default: false },
          receivedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    /*
     * "Recovered" now means an unhandled inquiry became a confirmed booking.
     * Sending an SMS alone must not set this field to true.
     */
    recovered: {
      type: Boolean,
      default: false,
    },

    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },

    // CALLBACKIQ_ATTRIBUTION_10OF10_FULL_V2: operational soft deletion.
    // Historical attribution reports intentionally retain these records.
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    deletionReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
  },
  {
    timestamps: true,
  },
);

/*
 * Supports recent call history and dashboard queries for one business.
 */
CallLogSchema.index({
  business: 1,
  createdAt: -1,
});
// CALLBACKIQ_ATTRIBUTION_10OF10_FULL_V2: operational call-history paging.
CallLogSchema.index({ business: 1, deletedAt: 1, createdAt: -1 });

/*
 * Supports filtering calls by answered, missed, busy, no_answer, and
 * other statuses while retaining newest-first sorting.
 */
CallLogSchema.index({
  business: 1,
  status: 1,
  createdAt: -1,
});
CallLogSchema.index({
  business: 1,
  marketingSource: 1,
  createdAt: -1,
});

/*
 * Supports caller-history lookups within a specific business.
 */
CallLogSchema.index({
  business: 1,
  from: 1,
  createdAt: -1,
});

/*
 * Prevents the same Twilio Call SID from being stored twice for one business.
 *
 * Run the Phase 0 duplicate audit before deploying this unique index against
 * an existing production database.
 */
CallLogSchema.index(
  {
    business: 1,
    providerCallId: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      providerCallId: {
        $gt: "",
      },
    },
  },
);

CallLogSchema.index(
  { business: 1, smsProviderMessageId: 1 },
  { partialFilterExpression: { smsProviderMessageId: { $gt: "" } } },
);
const CallLog =
  mongoose.models.CallLog || mongoose.model("CallLog", CallLogSchema);

export default CallLog;
