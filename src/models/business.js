import mongoose from "mongoose";
const { Schema } = mongoose;

import * as validate from "../helpers/model/business.js";

const BusinessFeaturesSchema = new Schema(
  {
    missedCallSmsEnabled: {
      type: Boolean,
      default: true,
    },

    aiQualificationEnabled: {
      type: Boolean,
      default: true,
    },

    aiBookingEnabled: {
      type: Boolean,
      default: false,
    },

    automatedFollowUpEnabled: {
      type: Boolean,
      default: false,
    },

    voiceAiEnabled: {
      type: Boolean,
      default: false,
    },

    revenueTrackingEnabled: {
      type: Boolean,
      default: false,
    },

    calendarProvider: {
      type: String,
      enum: [
        "internal",
        "google",
        "jobber",
        "housecall_pro",
        "servicetitan",
      ],
      default: "internal",
    },
  },
  {
    _id: false,
  },
);

const BusinessSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Business owner is required"],
    },

    businessName: {
      type: String,
      required: [true, "Business name is required"],
      trim: true,
      maxlength: 100,
    },

    businessType: {
      type: String,
      enum: [
        "hvac",
        "plumbing",
        "roofing",
        "electrical",
        "restoration",
        "other",
      ],
      default: "other",
      validate: [validate.isValidBusinessType, "Invalid business type"],
    },

    // Twilio / CallBackIQ tracking number
    phone: {
      type: String,
      required: [true, "Business phone is required"],
      trim: true,
      validate: [validate.isValidPhone, "Please enter a valid phone number"],
    },

    // Real business/cell number calls should forward to
    forwardingPhone: {
      type: String,
      trim: true,
      default: "",
      validate: {
        validator(value) {
          if (!value) return true;
          return validate.isValidPhone(value);
        },
        message: "Please enter a valid forwarding phone number",
      },
    },

    email: {
      type: String,
      lowercase: true,
      trim: true,
      validate: [validate.isValidEmail, "Please enter a valid email"],
    },

    website: {
      type: String,
      trim: true,
      default: "",
    },

    address: {
      type: String,
      trim: true,
      default: "",
    },

    city: {
      type: String,
      trim: true,
      default: "",
    },

    state: {
      type: String,
      trim: true,
      default: "",
    },

    zipCode: {
      type: String,
      trim: true,
      default: "",
    },

    timezone: {
      type: String,
      default: "America/New_York",
    },

    smsTemplate: {
      type: String,
      default:
        "Hi, this is {{businessName}}. Sorry we missed your call. What service do you need help with today?",
      maxlength: 500,
    },

    // Set after onboarding or from Business Settings.
    // Leaving this null prevents inaccurate ROI calculations.
    estimatedJobValue: {
      type: Number,
      default: null,
      min: 0,
    },

    /*
     * Phase 0 rollout controls.
     *
     * Existing production functionality remains enabled. Features that have
     * not been built yet remain disabled until their implementation phase.
     */
    features: {
      type: BusinessFeaturesSchema,
      default: () => ({}),
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

/*
 * Supports frequent ownership lookups such as getBusinessByOwner().
 * This is intentionally not unique so future agency or multi-business
 * ownership functionality is not blocked.
 */
BusinessSchema.index({
  owner: 1,
});

/*
 * Supports Twilio webhook routing by the CallBackIQ tracking number.
 * This is intentionally not made unique during this update so existing
 * records cannot cause index creation to fail.
 */
BusinessSchema.index({
  phone: 1,
});

const Business =
  mongoose.models.Business || mongoose.model("Business", BusinessSchema);

export default Business;
