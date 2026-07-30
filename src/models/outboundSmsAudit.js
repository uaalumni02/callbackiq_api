import mongoose from "mongoose";

const { Schema } = mongoose;

const OutboundSmsAuditSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    actor: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    actorType: {
      type: String,
      enum: ["user", "ai", "automation", "voice", "webhook", "system"],
      default: "system",
    },
    source: {
      type: String,
      trim: true,
      maxlength: 80,
      default: "system",
    },
    usageCategory: {
      type: String,
      trim: true,
      maxlength: 80,
      default: "sms",
    },
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },
    lead: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },
    from: { type: String, required: true, trim: true },
    to: { type: String, required: true, trim: true },
    bodyHash: { type: String, required: true, trim: true },
    bodyLength: { type: Number, min: 0, default: 0 },
    providerMessageId: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["sent", "suppressed", "blocked", "failed"],
      required: true,
    },
    reason: { type: String, trim: true, maxlength: 240, default: "" },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

OutboundSmsAuditSchema.index({ business: 1, createdAt: -1 });
OutboundSmsAuditSchema.index({ business: 1, actor: 1, createdAt: -1 });
OutboundSmsAuditSchema.index({ business: 1, to: 1, createdAt: -1 });
OutboundSmsAuditSchema.index(
  { business: 1, providerMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerMessageId: { $gt: "" } },
  },
);

const OutboundSmsAudit =
  mongoose.models.OutboundSmsAudit ||
  mongoose.model("OutboundSmsAudit", OutboundSmsAuditSchema);

export default OutboundSmsAudit;
