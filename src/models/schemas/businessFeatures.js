import mongoose from "mongoose";
const { Schema } = mongoose;

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
    revenueRescueEnabled: { type: Boolean, default: false },
    revenueAutomationEnabled: { type: Boolean, default: false },
    conversationIntelligenceEnabled: { type: Boolean, default: false },
    marketingAttributionEnabled: { type: Boolean, default: false },
    jobberEnabled: { type: Boolean, default: false },
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

export default FeatureSettingsSchema;
