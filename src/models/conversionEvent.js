import mongoose from "mongoose";

const { Schema } = mongoose;

const ConversionEventSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    lead: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },
    appointment: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
    },
    callLog: { type: Schema.Types.ObjectId, ref: "CallLog", default: null },
    // CALLBACKIQ_MARKETING_ATTRIBUTION_V1: do not overload the existing source/channel fields.
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
    attribution: {
      sourceId: { type: String, trim: true, default: "" },
      sourceName: { type: String, trim: true, default: "" },
      channel: { type: String, trim: true, default: "" },
      campaign: { type: String, trim: true, default: "" },
      trackingNumberId: { type: String, trim: true, default: "" },
      trackingNumber: { type: String, trim: true, default: "" },
    },
    type: {
      type: String,
      enum: [
        "missed_call",
        "first_response",
        "customer_replied",
        "qualified",
        "appointment_offered",
        "appointment_booked",
        "appointment_canceled",
        "job_completed",
        "revenue_recorded",
        "human_takeover",
        "lead_lost",
      ],
      required: true,
    },
    channel: {
      type: String,
      enum: ["sms", "voice", "web", "manual"],
      default: "manual",
    },
    source: { type: String, trim: true, default: "" },
    estimatedValue: { type: Number, min: 0, default: null },
    valuation: { type: Schema.Types.Mixed, default: undefined },
    valuationVersion: { type: Number, min: 0, default: 0 },
    actualRevenue: { type: Number, min: 0, default: 0 },
    occurredAt: { type: Date, default: Date.now, required: true },
    idempotencyKey: { type: String, trim: true, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

ConversionEventSchema.index({ business: 1, occurredAt: -1, type: 1 });
// CALLBACKIQ_ATTRIBUTION_10OF10_FULL_V2: equality fields precede the range field.
ConversionEventSchema.index({ business: 1, type: 1, occurredAt: -1 });
ConversionEventSchema.index({
  business: 1,
  marketingSource: 1,
  type: 1,
  occurredAt: -1,
});
ConversionEventSchema.index({ business: 1, lead: 1, occurredAt: 1 });
ConversionEventSchema.index({ business: 1, appointment: 1, occurredAt: 1 });
ConversionEventSchema.index(
  { business: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  },
);

const ConversionEvent =
  mongoose.models.ConversionEvent ||
  mongoose.model("ConversionEvent", ConversionEventSchema);

export default ConversionEvent;
