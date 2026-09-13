import mongoose from "mongoose";

const { Schema } = mongoose;

const HandoffContactSchema = new Schema(
  {
    name: { type: String, trim: true, maxlength: 120, required: true },
    role: { type: String, trim: true, maxlength: 120, default: "" },
    phone: { type: String, trim: true, maxlength: 30, default: "" },
    email: { type: String, trim: true, lowercase: true, maxlength: 200, default: "" },
    priority: { type: Number, min: 1, max: 100, default: 1 },
    active: { type: Boolean, default: true },
    emergencyOnly: { type: Boolean, default: false },
  },
  { _id: true },
);

const BusinessOperationsSettingsSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      unique: true,
      index: true,
    },
    serviceEligibilityPolicy: {
      catalogComplete: { type: Boolean, default: false },
      excludedServices: { type: [String], default: [], validate: value => value.length <= 50 && value.every(term => term.length <= 100) },
    },
    humanHandoffContacts: {
      type: [HandoffContactSchema],
      default: [],
    },
    emergencyPolicy: {
      enabled: { type: Boolean, default: true },
      emergencyContactPhone: { type: String, trim: true, default: "" },
      emergencyInstructions: { type: String, trim: true, maxlength: 1500, default: "" },
      customerSafetyMessage: {
        type: String,
        trim: true,
        maxlength: 1000,
        default:
          "If anyone is in immediate danger, contact 911 or the appropriate emergency service now. Move to a safe location when possible.",
      },
      afterHoursAction: {
        type: String,
        enum: ["collect_details", "escalate", "handoff", "emergency_only"],
        default: "escalate",
      },
      pauseAiOnEmergency: { type: Boolean, default: true },
    },
    aiPermissions: {
      canDiscussServices: { type: Boolean, default: true },
      canDiscussDiagnosticFees: { type: Boolean, default: false },
      canCollectAddress: { type: Boolean, default: true },
      canCollectAppointmentPreference: { type: Boolean, default: true },
      canBookEligibleServices: { type: Boolean, default: false },
      canConfirmAvailability: { type: Boolean, default: false },
      requireHumanReviewForUnknownService: { type: Boolean, default: true },
    },
    followUpSettings: {
      enabled: { type: Boolean, default: false },
      maxAttempts: { type: Number, min: 0, max: 10, default: 3 },
      firstDelayMinutes: { type: Number, min: 5, max: 10080, default: 60 },
      subsequentDelayMinutes: { type: Number, min: 5, max: 10080, default: 1440 },
      stopOnCustomerReply: { type: Boolean, default: true },
      stopOnHumanTakeover: { type: Boolean, default: true },
    },
  },
  { timestamps: true },
);

const BusinessOperationsSettings =
  mongoose.models.BusinessOperationsSettings ||
  mongoose.model("BusinessOperationsSettings", BusinessOperationsSettingsSchema);

export default BusinessOperationsSettings;
