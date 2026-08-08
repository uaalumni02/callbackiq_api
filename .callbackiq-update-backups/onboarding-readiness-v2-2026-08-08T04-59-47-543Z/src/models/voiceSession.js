import mongoose from "mongoose";
import { customerLifecycleField } from "../helpers/customerLifecycle.js";

const { Schema } = mongoose;

const TranscriptEntrySchema = new Schema(
  {
    role: {
      type: String,
      enum: ["customer", "assistant", "system"],
      required: true,
    },
    text: { type: String, required: true, trim: true, maxlength: 4000 },
    at: { type: Date, default: Date.now },
    isFinal: { type: Boolean, default: true },
  },
  { _id: false },
);

const VoiceSessionSchema = new Schema(
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
      default: null,
    },
    lead: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    callLog: { type: Schema.Types.ObjectId, ref: "CallLog", default: null },
    providerCallSid: { type: String, required: true, trim: true },
    providerSessionId: { type: String, trim: true, default: null },
    from: { type: String, trim: true, default: "" },
    to: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: [
        "routing",
        "connecting",
        "active",
        "capturing_callback",
        "safety_escalated",
        "transferring",
        "completing",
        "fallback_sms",
        "completed",
        "failed",
        "canceled",
      ],
      default: "routing",
      index: true,
    },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
    lastActivityAt: { type: Date, default: Date.now },
    transcript: { type: [TranscriptEntrySchema], default: [] },
    summary: { type: String, trim: true, maxlength: 4000, default: "" },
    transferredToHuman: { type: Boolean, default: false },
    transferReason: { type: String, trim: true, maxlength: 1000, default: "" },
    appointment: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
    },
    estimatedValue: { type: Number, min: 0, default: 0 },
    failureReason: { type: String, trim: true, maxlength: 2000, default: "" },
    signatureValidated: { type: Boolean, default: false },
    fallbackSmsStatus: {
      type: String,
      enum: ["pending", "sending", "sent", "failed", "suppressed"],
      default: "pending",
    },
    fallbackSmsSentAt: { type: Date, default: null },
    fallbackSmsProviderMessageId: { type: String, trim: true, default: "" },
    confirmationSmsStatus: {
      type: String,
      enum: ["pending", "sending", "sent", "failed", "suppressed"],
      default: "pending",
    },
    confirmationSmsSentAt: { type: Date, default: null },
    confirmationSmsProviderMessageId: {
      type: String,
      trim: true,
      default: "",
    },
    outcome: {
      type: String,
      enum: [
        "booked",
        "callback_saved",
        "transfer_accepted",
        "direct_answer_resolved",
        "safety_escalated",
        "wrong_number",
        "caller_declined",
        "opted_out",
        "abandoned",
        "technical_failure",
      ],
      default: null,
      index: true,
    },
    outcomeCommittedAt: { type: Date, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false },
);

VoiceSessionSchema.index(
  { business: 1, providerCallSid: 1 },
  { unique: true },
);
VoiceSessionSchema.index(
  { providerSessionId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerSessionId: { $gt: "" } },
  },
);
VoiceSessionSchema.index({ business: 1, status: 1, startedAt: -1 });
VoiceSessionSchema.index({ business: 1, conversation: 1, startedAt: -1 });
VoiceSessionSchema.index({ status: 1, lastActivityAt: 1 });

const VoiceSession =
  mongoose.models.VoiceSession ||
  mongoose.model("VoiceSession", VoiceSessionSchema);

export default VoiceSession;
