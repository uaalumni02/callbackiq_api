import mongoose from "mongoose";
const { Schema } = mongoose;

import * as validate from "../helpers/model/message.js";

const SmsMediaSchema = new Schema(
  {
    providerUrl: { type: String, required: true, trim: true },
    contentType: { type: String, trim: true, default: "application/octet-stream" },
    providerIndex: { type: Number, min: 0, max: 9, required: true },
    storageStatus: { type: String, enum: ["provider", "mirrored", "expired", "failed"], default: "provider" },
    storageUrl: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const MessageSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },

    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },

    lead: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },

    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      required: true,
      validate: [validate.isValidDirection, "Invalid message direction"],
    },

    from: {
      type: String,
      required: true,
      trim: true,
    },

    to: {
      type: String,
      required: true,
      trim: true,
    },

    body: {
      type: String,
      default: "",
      trim: true,
      maxlength: 1600,
    },
    media: { type: [SmsMediaSchema], default: [] },

    provider: {
      type: String,
      enum: ["manual", "twilio", "system"],
      default: "manual",
    },

    /*
     * Twilio Message SID for inbound and outbound messages.
     *
     * The existing providerMessageId name is retained to avoid an unnecessary
     * data migration. Manual and system messages continue using an empty
     * string and are excluded from the unique provider index below.
     */
    providerMessageId: {
      type: String,
      default: "",
      trim: true,
    },
    // CALLBACKIQ_PRODUCTION_READINESS: browser/provider retry identity.
    clientOperationId: { type: String, trim: true, maxlength: 160, default: "" },

    status: {
      type: String,
      enum: ["queued", "sent", "delivered", "undelivered", "failed", "received", "suppressed"],
      default: "sent",
    },
    isAiGenerated: { type: Boolean, default: false },
    generatedBy: {
      type: String,
      enum: ["ai", "guardrail", "user", "customer", "automation", "voice", "system", ""],
      default: "",
    },
    usageCategory: { type: String, trim: true, maxlength: 80, default: "" },
    actorType: {
      type: String,
      enum: ["user", "customer", "ai", "automation", "voice", "webhook", "system", ""],
      default: "",
    },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    deliveryStatus: { type: String, trim: true, default: "" },
    deliveryErrorCode: { type: String, trim: true, default: "" },
    deliveryErrorMessage: { type: String, trim: true, maxlength: 1000, default: "" },
    encoding: { type: String, enum: ["", "GSM-7", "UCS-2"], default: "" },
    segmentCount: { type: Number, min: 0, default: 1 },
    deliveredAt: { type: Date, default: null },
    providerAcceptedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    inReplyToMessage: { type: Schema.Types.ObjectId, ref: "Message", default: null },
    deliveryAttemptedAt: { type: Date, default: null },
    deliveryUncertain: { type: Boolean, default: false },
    deliveryEvents: {
      type: [
        {
          providerStatus: { type: String, trim: true, default: "" },
          canonicalStatus: { type: String, trim: true, default: "" },
          errorCode: { type: String, trim: true, default: "" },
          errorMessage: { type: String, trim: true, maxlength: 1000, default: "" },
          applied: { type: Boolean, default: false },
          conflict: { type: Boolean, default: false },
          receivedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    aiOutcome: {
      intent: { type: String, trim: true, maxlength: 80, default: "" },
      serviceNeeded: { type: String, trim: true, maxlength: 200, default: "" },
      urgency: { type: String, trim: true, maxlength: 40, default: "" },
      address: { type: String, trim: true, maxlength: 500, default: "" },
      preferredAppointmentTime: { type: String, trim: true, maxlength: 500, default: "" },
      bookingState: { type: String, trim: true, maxlength: 80, default: "" },
      bookingReady: { type: Boolean, default: false },
      confidence: { type: Number, min: 0, max: 100, default: 0 },
      outcome: { type: String, trim: true, maxlength: 80, default: "" },
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
  },
);

MessageSchema.pre("validate", function validateMessageContent() {
  if (!String(this.body || "").trim() && (!Array.isArray(this.media) || this.media.length === 0)) {
    this.invalidate("body", "A message must include text or media.");
  }
});

/*
 * Supports loading a complete transcript in chronological order.
 */
MessageSchema.index({
  conversation: 1,
  createdAt: 1,
});

/*
 * Supports recent message queries and business dashboard calculations.
 */
MessageSchema.index({
  business: 1,
  createdAt: -1,
});
MessageSchema.index({
  business: 1,
  isAiGenerated: 1,
  createdAt: -1,
});

/*
 * Prevents the same Twilio Message SID from being stored twice for one
 * business while excluding manual and system messages that have no SID.
 *
 * Run the Phase 0 duplicate audit before deploying this unique index against
 * an existing production database.
 */
MessageSchema.index(
  {
    business: 1,
    providerMessageId: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      providerMessageId: {
        $gt: "",
      },
    },
  },
);

MessageSchema.index(
  { business: 1, clientOperationId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientOperationId: { $gt: "" } },
    name: "message_business_client_operation_unique",
  },
);
MessageSchema.index(
  { business: 1, inReplyToMessage: 1 },
  { unique: true, partialFilterExpression: { inReplyToMessage: { $type: "objectId" } } },
);
MessageSchema.index({ business: 1, deliveryStatus: 1, createdAt: -1 });

MessageSchema.index({ business: 1, lead: 1, direction: 1, createdAt: -1 });

const Message =
  mongoose.models.Message || mongoose.model("Message", MessageSchema);

export default Message;
