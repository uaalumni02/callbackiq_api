import mongoose from "mongoose";
const { Schema } = mongoose;

import * as validate from "../helpers/model/lead.js";

const LeadSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: [true, "Business is required"],
    },

    customerName: {
      type: String,
      trim: true,
      default: "",
    },

    phone: {
      type: String,
      required: [true, "Phone number is required"],
      trim: true,
      validate: [validate.isValidPhone, "Please enter a valid phone number"],
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
      validate: [validate.isValidEmail, "Please enter a valid email"],
    },

    serviceNeeded: {
      type: String,
      required: [true, "Service needed is required"],
      trim: true,
      maxlength: 200,
    },

    urgency: {
      type: String,
      enum: ["low", "medium", "high", "emergency"],
      default: "medium",
      validate: [validate.isValidUrgency, "Invalid urgency"],
    },

    address: {
      type: String,
      trim: true,
      default: "",
    },

    preferredAppointmentTime: {
      type: String,
      trim: true,
      default: "",
    },

    leadQualityScore: {
      type: Number,
      min: 0,
      max: 100,
      default: 50,
    },

    estimatedValue: {
      type: Number,
      min: 0,
      default: 0,
    },

    status: {
      type: String,
      enum: ["new", "contacted", "booked", "lost", "spam"],
      default: "new",
      validate: [validate.isValidStatus, "Invalid lead status"],
    },

    source: {
      type: String,
      enum: ["missed_call", "manual", "sms", "web", "other"],
      default: "manual",
    },

    summary: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1000,
    },

    notes: {
      type: String,
      trim: true,
      default: "",
      maxlength: 2000,
    },
  },
  {
    timestamps: true,
  },
);

/*
 * Supports the default recent-leads list and business-level counts.
 */
LeadSchema.index({
  business: 1,
  createdAt: -1,
});

/*
 * Supports status filters such as new, contacted, booked, lost, and spam.
 */
LeadSchema.index({
  business: 1,
  status: 1,
  createdAt: -1,
});

/*
 * Supports detecting and locating previous leads from the same caller.
 */
LeadSchema.index({
  business: 1,
  phone: 1,
  createdAt: -1,
});

/*
 * Supports urgency filters for high-priority and emergency leads.
 */
LeadSchema.index({
  business: 1,
  urgency: 1,
  createdAt: -1,
});

/*
 * Supports hot-lead sorting by lead quality score.
 */
LeadSchema.index({
  business: 1,
  leadQualityScore: -1,
  createdAt: -1,
});

const Lead = mongoose.models.Lead || mongoose.model("Lead", LeadSchema);

export default Lead;
