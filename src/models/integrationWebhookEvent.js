import mongoose from "mongoose";

const { Schema } = mongoose;

const IntegrationWebhookEventSchema = new Schema(
  {
    provider: {
      type: String,
      enum: ["google_calendar", "jobber"],
      required: true,
    },
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      default: null,
    },
    eventKey: { type: String, required: true, trim: true },
    topic: { type: String, trim: true, default: "" },
    externalItemId: { type: String, trim: true, default: "" },
    occurredAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["queued", "processing", "processed", "failed", "ignored"],
      default: "queued",
    },
    attempts: { type: Number, min: 0, default: 0 },
    payload: { type: Schema.Types.Mixed, default: {} },
    headers: { type: Schema.Types.Mixed, default: {} },
    errorMessage: { type: String, trim: true, default: "", maxlength: 2000 },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

IntegrationWebhookEventSchema.index(
  { provider: 1, eventKey: 1 },
  { unique: true },
);
IntegrationWebhookEventSchema.index({ status: 1, createdAt: 1 });
IntegrationWebhookEventSchema.index({ business: 1, provider: 1, createdAt: -1 });

const IntegrationWebhookEvent =
  mongoose.models.IntegrationWebhookEvent ||
  mongoose.model("IntegrationWebhookEvent", IntegrationWebhookEventSchema);

export default IntegrationWebhookEvent;
