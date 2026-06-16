import mongoose from "mongoose";
const { Schema } = mongoose;

import * as validate from "../helpers/model/alert.js";

const AlertSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: [true, "Business is required"],
    },

    lead: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },

    type: {
      type: String,
      enum: ["hot_lead", "missed_call", "booked_job", "system"],
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
      enum: ["pending", "sent", "failed", "read"],
      default: "pending",
      validate: [validate.isValidAlertStatus, "Invalid alert status"],
    },

    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
      validate: [validate.isValidAlertPriority, "Invalid alert priority"],
    },

    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },

    readAt: {
      type: Date,
      default: null,
    },

    sentAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

const Alert = mongoose.models.Alert || mongoose.model("Alert", AlertSchema);

export default Alert;
