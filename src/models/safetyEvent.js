import mongoose from "mongoose";
const { Schema } = mongoose;

const SafetyEventSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    lead: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },
    inboundMessage: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      required: true,
    },
    outboundMessage: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    alert: {
      type: Schema.Types.ObjectId,
      ref: "Alert",
      default: null,
    },
    providerMessageId: {
      type: String,
      required: true,
      trim: true,
    },
    outboundProviderMessageId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    hazardType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    hazardTypes: {
      type: [String],
      default: [],
    },
    source: {
      type: String,
      enum: ["deterministic", "classifier", "combined", "ai_pipeline"],
      default: "deterministic",
    },
    confidence: {
      type: Number,
      min: 0,
      max: 1,
      default: 1,
    },
    triggeringMessageHash: {
      type: String,
      required: true,
      trim: true,
    },
    triggeringMessagePreview: {
      type: String,
      maxlength: 500,
      default: "",
    },
    replyText: {
      type: String,
      maxlength: 500,
      default: "",
    },
    humanTakeoverActivated: {
      type: Boolean,
      default: true,
    },
    aiBypassed: {
      type: Boolean,
      default: true,
    },
    status: {
      type: String,
      enum: [
        "detected",
        "reply_reserved",
        "reply_sent",
        "delivered",
        "delivery_failed",
        "acknowledged",
      ],
      default: "detected",
      index: true,
    },
    deliveryStatus: {
      type: String,
      default: "",
    },
    deliveryErrorCode: {
      type: String,
      default: "",
    },
    detectedAt: {
      type: Date,
      default: Date.now,
    },
    replySentAt: {
      type: Date,
      default: null,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    acknowledgedAt: {
      type: Date,
      default: null,
    },
    acknowledgedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

SafetyEventSchema.index(
  { business: 1, providerMessageId: 1 },
  { unique: true },
);
SafetyEventSchema.index({ business: 1, createdAt: -1 });
SafetyEventSchema.index({ business: 1, status: 1, createdAt: -1 });

const SafetyEvent =
  mongoose.models.SafetyEvent ||
  mongoose.model("SafetyEvent", SafetyEventSchema);

export default SafetyEvent;
