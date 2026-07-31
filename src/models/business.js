import mongoose from "mongoose";
const { Schema } = mongoose;

import * as validate from "../helpers/model/business.js";

const FeatureSettingsSchema = new Schema(
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
  { _id: false },
);

const VerifiedFactSchema = new Schema(
  {
    value: {
      type: Schema.Types.Mixed,
      default: null,
    },
    verified: {
      type: Boolean,
      default: false,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    verifiedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    source: {
      type: String,
      enum: ["owner", "admin", "integration", "migration"],
      default: "owner",
    },
  },
  { _id: false },
);

const VerifiedFactsSchema = new Schema(
  {
    businessHours: {
      type: VerifiedFactSchema,
      default: () => ({}),
    },
    approvedServices: {
      type: VerifiedFactSchema,
      default: () => ({}),
    },
    serviceAreas: {
      type: VerifiedFactSchema,
      default: () => ({}),
    },
    pricing: {
      type: VerifiedFactSchema,
      default: () => ({}),
    },
    schedulingRules: {
      type: VerifiedFactSchema,
      default: () => ({}),
    },
    availabilityPolicy: {
      type: VerifiedFactSchema,
      default: () => ({}),
    },
    emergencyServiceAvailable: {
      type: VerifiedFactSchema,
      default: () => ({}),
    },
    financing: {
      type: VerifiedFactSchema,
      default: () => ({}),
    },
    warrantyPolicy: {
      type: VerifiedFactSchema,
      default: () => ({}),
    },
    cancellationPolicy: {
      type: VerifiedFactSchema,
      default: () => ({}),
    },
    brandsServiced: {
      type: VerifiedFactSchema,
      default: () => ({}),
    },
    diagnosticFee: {
      type: VerifiedFactSchema,
      default: () => ({}),
    },
  },
  { _id: false },
);

const AICapabilitiesSchema = new Schema(
  {
    canCollectLeadDetails: {
      type: Boolean,
      default: true,
    },
    canCollectAddress: {
      type: Boolean,
      default: true,
    },
    canCollectAppointmentPreference: {
      type: Boolean,
      default: true,
    },
    canConfirmAppointment: {
      type: Boolean,
      default: false,
    },
    canConfirmAvailability: {
      type: Boolean,
      default: false,
    },
    canConfirmDispatch: {
      type: Boolean,
      default: false,
    },
    canQuotePrices: {
      type: Boolean,
      default: false,
    },
    canConfirmWarranty: {
      type: Boolean,
      default: false,
    },
    canConfirmServiceArea: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false },
);

const IntegrationStateSchema = new Schema(
  {
    provider: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      enum: ["disconnected", "pending", "connected", "failed"],
      default: "disconnected",
    },
    verified: {
      type: Boolean,
      default: false,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    externalAccountId: {
      type: String,
      trim: true,
      default: "",
      select: false,
    },
  },
  { _id: false },
);

const VoiceRoutingPolicySchema = new Schema(
  {
    openHours: {
      type: String,
      enum: [
        "voice_ai",
        "sms",
        "staff_then_voice_ai",
        "staff_then_sms",
      ],
      default: "staff_then_voice_ai",
    },
    afterHours: {
      type: String,
      enum: [
        "voice_ai",
        "sms",
        "staff_then_voice_ai",
        "staff_then_sms",
      ],
      default: "voice_ai",
    },
    voiceFailure: {
      type: String,
      enum: ["sms", "staff_then_sms"],
      default: "sms",
    },
  },
  { _id: false },
);

const CommunicationLimitsSchema = new Schema(
  {
    smsBusinessHourly: { type: Number, min: 1, max: 1000000, default: 300 },
    smsBusinessDaily: { type: Number, min: 1, max: 1000000, default: 3000 },
    smsCustomerHourly: { type: Number, min: 1, max: 100000, default: 30 },
    smsCustomerDaily: { type: Number, min: 1, max: 100000, default: 120 },
    aiBusinessHourly: { type: Number, min: 1, max: 1000000, default: 150 },
    aiBusinessDaily: { type: Number, min: 1, max: 1000000, default: 1000 },
    aiCustomerHourly: { type: Number, min: 1, max: 100000, default: 20 },
    aiCustomerDaily: { type: Number, min: 1, max: 100000, default: 60 },
    alertThresholdPercent: { type: Number, min: 50, max: 100, default: 80 },
  },
  { _id: false },
);
const VoiceSettingsSchema = new Schema(
  {
    answerMode: {
      type: String,
      enum: ["after_hours", "overflow", "always", "disabled", "custom"],
      default: "disabled",
    },
    routingPolicyVersion: {
      type: Number,
      min: 0,
      default: 0,
    },
    routingPolicy: {
      type: VoiceRoutingPolicySchema,
      default: () => ({}),
    },
    overflowRingSeconds: { type: Number, min: 5, max: 60, default: 20 },
    liveTransferEnabled: { type: Boolean, default: false },
    transferPhone: {
      type: String,
      trim: true,
      default: "",
      validate: {
        validator(value) {
          if (!value) return true;
          return validate.isValidPhone(value);
        },
        message: "Please enter a valid voice transfer phone number",
      },
    },
    liveTransferPhone: {
      type: String,
      trim: true,
      default: "",
      validate: {
        validator(value) {
          if (!value) return true;
          return validate.isValidPhone(value);
        },
        message: "Please enter a valid live-transfer phone number",
      },
    },
    welcomeGreeting: {
      type: String,
      trim: true,
      maxlength: 300,
      default: "Thanks for calling. How can I help you today?",
    },
    voiceName: { type: String, trim: true, maxlength: 200, default: "" },
    maxConcurrentCalls: { type: Number, min: 1, max: 100, default: 25 },
    maxCallDurationSeconds: { type: Number, min: 60, max: 7200, default: 3600 },
    recordingEnabled: { type: Boolean, default: false },
  },
  { _id: false },
);

const BusinessSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Business owner is required"],
      index: true,
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
      default: "",
      validate: {
        validator(value) {
          if (!value) return true;
          return validate.isValidEmail(value);
        },
        message: "Please enter a valid email",
      },
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

    features: {
      type: FeatureSettingsSchema,
      default: () => ({}),
    },
    communicationLimits: {
      type: CommunicationLimitsSchema,
      default: () => ({}),
    },
    voiceSettings: {
      type: VoiceSettingsSchema,
      default: () => ({}),
    },

    aiKnowledge: {
      verifiedFacts: {
        type: VerifiedFactsSchema,
        default: () => ({}),
      },
      lastReviewedAt: {
        type: Date,
        default: null,
      },
      lastReviewedBy: {
        type: Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
    },

    aiCapabilities: {
      type: AICapabilitiesSchema,
      default: () => ({}),
    },

    aiSettings: {
      aiDisclosureEnabled: {
        type: Boolean,
        default: true,
      },
    },

    integrations: {
      calendar: {
        type: IntegrationStateSchema,
        default: () => ({
          provider: "internal",
          status: "disconnected",
          verified: false,
        }),
      },
      dispatch: {
        type: IntegrationStateSchema,
        default: () => ({}),
      },
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

BusinessSchema.index({ owner: 1, createdAt: -1 });
BusinessSchema.index({ phone: 1 }, { unique: true });

const Business =
  mongoose.models.Business || mongoose.model("Business", BusinessSchema);

export default Business;
