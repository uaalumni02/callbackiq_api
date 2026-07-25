import mongoose from "mongoose";

import * as validate from "../helpers/model/alert.js";

const { Schema } = mongoose;

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
      enum: [
        "hot_lead",
        "missed_call",
        "customer_reply",
        "booked_job",
        "system",
      ],
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

    /*
     * Critical is required for safety and emergency alerts. The matching
     * helper in src/helpers/model/alert.js must also accept "critical".
     */
    priority: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
      validate: [validate.isValidAlertPriority, "Invalid alert priority"],
    },

    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },

    /*
     * Automatic alert workflows use this value to remain idempotent when a
     * provider retries a webhook or two requests run concurrently.
     */
    dedupeKey: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
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

AlertSchema.index({
  business: 1,
  createdAt: -1,
});

AlertSchema.index({
  business: 1,
  readAt: 1,
  createdAt: -1,
});

AlertSchema.index({
  business: 1,
  status: 1,
  createdAt: -1,
});

AlertSchema.index(
  {
    business: 1,
    dedupeKey: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      dedupeKey: {
        $type: "string",
      },
    },
  },
);

const Alert = mongoose.models.Alert || mongoose.model("Alert", AlertSchema);

export default Alert;
