import mongoose from "mongoose";
import { customerLifecycleField } from "../helpers/customerLifecycle.js";

const { Schema } = mongoose;

const AddressSchema = new Schema(
  {
    street: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    postalCode: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const PendingProviderChangeSchema = new Schema(
  {
    type: { type: String, enum: ["move", "cancel"], required: true },
    status: {
      type: String,
      enum: ["pending_review", "approved", "rejected"],
      default: "pending_review",
    },
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    calendarId: { type: String, trim: true, default: "" },
    eventId: { type: String, trim: true, default: "" },
    eventSequence: { type: String, trim: true, default: "" },
    detectedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false },
);

const AppointmentSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    customerLifecycleStatus: { ...customerLifecycleField },
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
    serviceOffering: {
      type: Schema.Types.ObjectId,
      ref: "ServiceOffering",
      required: true,
    },

    customerName: { type: String, trim: true, default: "Customer" },
    customerPhone: { type: String, trim: true, required: true },
    customerEmail: { type: String, trim: true, lowercase: true, default: "" },
    address: { type: AddressSchema, default: () => ({}) },

    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    timezone: { type: String, required: true, default: "America/New_York" },
    bufferBeforeMinutes: { type: Number, min: 0, default: 0 },
    bufferAfterMinutes: { type: Number, min: 0, default: 0 },

    status: {
      type: String,
      enum: [
        "held",
        "confirmed",
        "canceled",
        "completed",
        "no_show",
        "failed",
        "rescheduled",
      ],
      default: "held",
      required: true,
    },
    source: {
      type: String,
      enum: ["sms", "voice", "web", "manual"],
      default: "manual",
      required: true,
    },
    bookedBy: {
      type: String,
      enum: ["ai", "customer", "staff"],
      default: "staff",
      required: true,
    },

    // CALLBACKIQ_MARKETING_ATTRIBUTION_V1: immutable booking attribution snapshot.
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

    provider: { type: String, trim: true, default: "internal" },
    externalAppointmentId: { type: String, trim: true, default: null },
    externalCalendarId: { type: String, trim: true, default: null },

    estimatedValue: { type: Number, min: 0, default: 0 },
    actualRevenue: { type: Number, min: 0, default: 0 },

    idempotencyKey: { type: String, trim: true, required: true },
    activeSlotKey: { type: String, trim: true, default: null },
    slotClaimKeys: { type: [String], default: [] },
    capacityLane: { type: Number, min: 1, default: null },
    heldExpiresAt: { type: Date, default: null },
    requiresBusinessApproval: { type: Boolean, default: false, index: true },
    approvalRequestedAt: { type: Date, default: null },
    approvalDecisionAt: { type: Date, default: null },
    approvalDecisionBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvalDeclineReason: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1000,
    },
    failureReason: { type: String, trim: true, default: "", maxlength: 2000 },

    confirmedAt: { type: Date, default: null },
    customerConfirmedAt: { type: Date, default: null },
    customerRescheduleRequestedAt: { type: Date, default: null },
    pendingProviderChange: {
      type: PendingProviderChangeSchema,
      default: null,
    },
    canceledAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    noShowAt: { type: Date, default: null },

    rescheduledFrom: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
    },
    rescheduledTo: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
    },
    notes: { type: String, trim: true, default: "", maxlength: 4000 },
  },
  { timestamps: true },
);

AppointmentSchema.pre("validate", function validateTimes() {
  if (this.startAt && this.endAt && this.endAt <= this.startAt) {
    this.invalidate("endAt", "endAt must be after startAt");
  }
});

AppointmentSchema.index({ business: 1, startAt: 1, status: 1 });
AppointmentSchema.index(
  { business: 1, idempotencyKey: 1 },
  { unique: true },
);
AppointmentSchema.index(
  { provider: 1, externalAppointmentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      externalAppointmentId: { $type: "string" },
    },
  },
);

/*
 * A slot key is retained only while an appointment actively owns a slot.
 * Cancel, failure, completion, no-show and reschedule workflows clear it.
 * This index is the final concurrency guard against two simultaneous claims.
 */
AppointmentSchema.index(
  { business: 1, activeSlotKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      activeSlotKey: { $type: "string" },
    },
  },
);
AppointmentSchema.index(
  { business: 1, slotClaimKeys: 1 },
  {
    unique: true,
    partialFilterExpression: {
      "slotClaimKeys.0": { $exists: true },
    },
  },
);
AppointmentSchema.index({ business: 1, heldExpiresAt: 1, status: 1 });
AppointmentSchema.index({
  business: 1,
  requiresBusinessApproval: 1,
  status: 1,
  startAt: 1,
});
AppointmentSchema.index({
  business: 1,
  "pendingProviderChange.status": 1,
  updatedAt: -1,
});
AppointmentSchema.index({ business: 1, lead: 1, createdAt: -1 });
AppointmentSchema.index({ business: 1, conversation: 1, createdAt: -1 });

const Appointment =
  mongoose.models.Appointment || mongoose.model("Appointment", AppointmentSchema);

export default Appointment;
