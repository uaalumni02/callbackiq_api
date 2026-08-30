import mongoose from "mongoose";

const { Schema } = mongoose;

const AttributionTouchSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    lead: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
      index: true,
    },
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },
    callLog: {
      type: Schema.Types.ObjectId,
      ref: "CallLog",
      default: null,
      index: true,
    },
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
    },
    visitorId: { type: String, trim: true, default: "" },
    sessionId: { type: String, trim: true, default: "" },
    source: { type: String, trim: true, default: "" },
    medium: { type: String, trim: true, default: "" },
    campaign: { type: String, trim: true, default: "" },
    term: { type: String, trim: true, default: "" },
    content: { type: String, trim: true, default: "" },
    landingPage: { type: String, trim: true, default: "" },
    referrer: { type: String, trim: true, default: "" },
    clickIds: {
      gclid: { type: String, trim: true, default: "" },
      gbraid: { type: String, trim: true, default: "" },
      wbraid: { type: String, trim: true, default: "" },
      fbclid: { type: String, trim: true, default: "" },
    },
    method: {
      type: String,
      enum: [
        "tracking_number",
        "website_session",
        "self_reported",
        "manual",
        "integration",
      ],
      default: "tracking_number",
    },
    confidence: {
      type: String,
      enum: ["high", "medium", "low"],
      default: "high",
    },
    selfReportedRaw: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    occurredAt: {
      type: Date,
      default: Date.now,
      immutable: true,
      index: true,
    },
  },
  { timestamps: true },
);

AttributionTouchSchema.index({
  business: 1,
  lead: 1,
  occurredAt: 1,
});
AttributionTouchSchema.index({
  business: 1,
  marketingSource: 1,
  occurredAt: -1,
});

const AttributionTouch =
  mongoose.models.AttributionTouch ||
  mongoose.model("AttributionTouch", AttributionTouchSchema);

export default AttributionTouch;
