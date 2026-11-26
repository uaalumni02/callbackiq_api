import mongoose from 'mongoose';
import {pilotVoiceLimits} from '../../config/pilotBudgets.js';
import * as validate from '../../helpers/model/business.js';
const {Schema}=mongoose;
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
    overflowRingSeconds: { type: Number, min: 15, max: 25, default: 20 },
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
      default: "",
    },
    voiceName: { type: String, trim: true, maxlength: 80, default: "" },
    maxConcurrentCalls: { type: Number, min: 1, max: 100, default: 25 },
    maxCallDurationSeconds: { type: Number, min: 60, max: 600, default: 600 },
    dailyVoiceMinutes: {
      type: Number,
      min: 1,
      max: 100000,
      default: () => pilotVoiceLimits().dailySeconds / 60,
    },
    monthlyVoiceMinutes: {
      type: Number,
      min: 1,
      max: 1000000,
      default: () => pilotVoiceLimits().monthlySeconds / 60,
    },
    voiceHardCapEnabled: { type: Boolean, default: true },
    voiceOverageEnabled: { type: Boolean, default: false },
    voiceUsageWarningThresholds: {
      type: [Number],
      default: [70, 85, 100],
    },
    callerVelocityLimitPerHour: {
      type: Number,
      min: 1,
      max: 1000,
      default: 10,
    },
    agentConfirmationRequired: { type: Boolean, default: true },
    answeringMachineDetectionEnabled: { type: Boolean, default: true },
    recordingEnabled: { type: Boolean, default: false },
  },
  { _id: false },
);

export default VoiceSettingsSchema;
