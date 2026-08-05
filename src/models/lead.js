import { normalizePhoneToE164 } from "../voice/voicePhone.service.js";
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
    customerName: { type: String, trim: true, default: "" },
    phone: {
      type: String,
      required: [true, "Phone number is required"],
      trim: true,
      validate: [validate.isValidPhone, "Please enter a valid phone number"],
    },
    phoneLookup: { type: String, trim: true, default: "" },
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
    address: { type: String, trim: true, default: "" },
    preferredAppointmentTime: { type: String, trim: true, default: "" },
    leadQualityScore: { type: Number, min: 0, max: 100, default: 50 },
    estimatedValue: { type: Number, min: 0, default: 0 },
    actualRevenue: { type: Number, min: 0, default: 0 },
    status: {
      type: String,
      enum: ["new", "contacted", "booked", "lost", "spam"],
      default: "new",
      validate: [validate.isValidStatus, "Invalid lead status"],
    },
    source: {
      type: String,
      enum: ["missed_call", "manual", "sms", "voice", "web", "other"],
      default: "manual",
    },
    summary: { type: String, trim: true, default: "", maxlength: 1000 },
    notes: { type: String, trim: true, default: "", maxlength: 2000 },

    qualifiedAt: { type: Date, default: null },
    firstRespondedAt: { type: Date, default: null },
    bookedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    appointment: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
    },
    recovered: { type: Boolean, default: false },
    recoveredBy: {
      type: String,
      enum: ["sms_ai", "voice_ai", "staff", "manual"],
      default: null,
    },
    lossReason: { type: String, trim: true, default: "", maxlength: 500 },
  },
  { timestamps: true },
);

LeadSchema.pre("validate", function normalizeLeadPhone() {
  const normalized = normalizePhoneToE164(this.phone);
  if (normalized) {
    this.phone = normalized;
    this.phoneLookup = normalized;
  }
});

const normalizeLeadPhoneUpdate = function normalizeLeadPhoneUpdate() {
  const update = this.getUpdate() || {};
  for (const target of [update, update.$set, update.$setOnInsert].filter(Boolean)) {
    if (!target.phone) continue;
    const normalized = normalizePhoneToE164(target.phone);
    if (normalized) {
      target.phone = normalized;
      target.phoneLookup = normalized;
    }
  }
};
LeadSchema.pre("findOneAndUpdate", normalizeLeadPhoneUpdate);
LeadSchema.pre("updateOne", normalizeLeadPhoneUpdate);
LeadSchema.pre("updateMany", normalizeLeadPhoneUpdate);

const normalizeLeadPhoneFilter = function normalizeLeadPhoneFilter() {
  const filter = this.getFilter() || {};
  const normalizeTarget = (target) => {
    if (!target || typeof target !== "object") return;
    if (typeof target.phone === "string") {
      const normalized = normalizePhoneToE164(target.phone);
      if (normalized) target.phone = normalized;
    }
  };
  normalizeTarget(filter);
  if (Array.isArray(filter.$or)) filter.$or.forEach(normalizeTarget);
};
for (const operation of ["find", "findOne", "countDocuments", "findOneAndDelete", "deleteOne"]) {
  LeadSchema.pre(operation, normalizeLeadPhoneFilter);
}

LeadSchema.index({ business: 1, createdAt: -1 });
LeadSchema.index({ business: 1, status: 1, createdAt: -1 });
LeadSchema.index({ business: 1, phone: 1, createdAt: -1 });
LeadSchema.index({ business: 1, urgency: 1, createdAt: -1 });
LeadSchema.index({ business: 1, leadQualityScore: -1, createdAt: -1 });
LeadSchema.index({ business: 1, recovered: 1, bookedAt: -1 });
LeadSchema.index({ business: 1, appointment: 1 });

LeadSchema.index(
  { business: 1, phoneLookup: 1 },
  { unique: true, partialFilterExpression: { phoneLookup: { $gt: "" } } },
);
const Lead = mongoose.models.Lead || mongoose.model("Lead", LeadSchema);
export default Lead;
