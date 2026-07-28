import mongoose from "mongoose";

import * as validate from "../helpers/model/alert.js";

const { Schema } = mongoose;
const alertTypes = [...validate.ALERT_TYPES];

const AlertSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: [true, "Business is required"],
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
    type: {
      type: String,
      enum: alertTypes,
      required: true,
      validate: [validate.isValidAlertType, "Invalid alert type"],
    },
    channel: {
      type: String,
      enum: ["in_app", "email", "sms"],
      default: "in_app",
      validate: [validate.isValidAlertChannel, "Invalid alert channel"],
    },
    title: {
      type: String,
      required: [true, "Alert title is required"],
      trim: true,
      maxlength: 120,
    },
    message: {
      type: String,
      required: [true, "Alert message is required"],
      trim: true,
      maxlength: 1000,
    },
    status: {
      type: String,
      enum: ["pending", "sent", "failed", "read", "acknowledged", "resolved"],
      default: "pending",
      validate: [validate.isValidAlertStatus, "Invalid alert status"],
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
      validate: [validate.isValidAlertPriority, "Invalid alert priority"],
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
    dedupeKey: { type: String, trim: true, maxlength: 200, default: null },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null },
    assignedAt: { type: Date, default: null },
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    acknowledgedAt: { type: Date, default: null },
    acknowledgedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    resolution: { type: String, trim: true, default: "", maxlength: 2000 },
    actionRequired: { type: Boolean, default: false },
    dueAt: { type: Date, default: null },
    reason: { type: String, trim: true, default: "", maxlength: 1000 },
    recommendedAction: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1000,
    },
    aiSummary: { type: String, trim: true, default: "", maxlength: 2000 },
    lastCustomerMessage: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1600,
    },
    readAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

AlertSchema.index({ business: 1, createdAt: -1 });
AlertSchema.index({ business: 1, readAt: 1, createdAt: -1 });
AlertSchema.index({ business: 1, status: 1, createdAt: -1 });
AlertSchema.index({
  business: 1,
  actionRequired: 1,
  priority: 1,
  resolvedAt: 1,
  createdAt: -1,
});
AlertSchema.index({ business: 1, assignedTo: 1, resolvedAt: 1, dueAt: 1 });
AlertSchema.index(
  { business: 1, dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: "string" } },
  },
);

const Alert = mongoose.models.Alert || mongoose.model("Alert", AlertSchema);

export default Alert;
