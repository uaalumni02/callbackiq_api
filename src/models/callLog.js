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

/*
 * Supports filtering calls by answered, missed, busy, no_answer, and
 * other statuses while retaining newest-first sorting.
 */
CallLogSchema.index({
  business: 1,
  status: 1,
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
