import mongoose from "mongoose";

const { Schema } = mongoose;

const WebhookEventSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },

    provider: {
      type: String,
      enum: ["twilio"],
      default: "twilio",
      required: true,
    },

    eventType: {
      type: String,
      enum: [
        "inbound_sms",
        "inbound_voice",
        "voice_status",
        "message_status",
      ],
      required: true,
    },

    eventKey: {
      type: String,
      required: true,
      trim: true,
    },

    providerEventId: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: String,
      enum: ["processing", "completed", "failed"],
      default: "processing",
      required: true,
    },

    attemptCount: {
      type: Number,
      default: 1,
      min: 1,
    },

    duplicateCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Proof of one successful conditional settlement; no index or migration needed.
    settlementReceipt: { type: String, trim: true },
    leaseToken: { type: String, trim: true, default: "" },
    leaseExpiresAt: { type: Date, default: null },
    processingStartedAt: { type: Date, default: null },

    firstReceivedAt: {
      type: Date,
      default: Date.now,
    },

    lastReceivedAt: {
      type: Date,
      default: Date.now,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    failureReason: {
      type: String,
      trim: true,
      default: "",
      maxlength: 2000,
    },

    responseStatusCode: {
      type: Number,
      default: null,
    },

    responseContentType: {
      type: String,
      trim: true,
      default: "",
    },

    responseBody: {
      type: String,
      default: "",
    },

    requestMetadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

WebhookEventSchema.index(
  {
    business: 1,
    provider: 1,
    eventType: 1,
    eventKey: 1,
  },
  {
    unique: true,
  },
);

WebhookEventSchema.index({
  status: 1,
  createdAt: -1,
});

WebhookEventSchema.index({ status: 1, leaseExpiresAt: 1 });

const WebhookEvent =
  mongoose.models.WebhookEvent ||
  mongoose.model("WebhookEvent", WebhookEventSchema);

export default WebhookEvent;
