import mongoose from "mongoose";
const { Schema } = mongoose;

import * as validate from "../helpers/model/callLog.js";

const CallLogSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },

    lead: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },

    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },

    from: {
      type: String,
      required: true,
      trim: true,
      validate: [validate.isValidPhone, "Invalid caller phone number"],
    },

    to: {
      type: String,
      required: true,
      trim: true,
      validate: [validate.isValidPhone, "Invalid receiving phone number"],
    },

    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      default: "inbound",
      validate: [validate.isValidDirection, "Invalid call direction"],
    },

    status: {
      type: String,
      enum: ["answered", "missed", "voicemail", "failed", "busy", "no_answer"],
      default: "missed",
      validate: [validate.isValidStatus, "Invalid call status"],
    },

    durationSeconds: {
      type: Number,
      default: 0,
      min: 0,
    },

    provider: {
      type: String,
      enum: ["manual", "twilio", "system"],
      default: "manual",
    },

    providerCallId: {
      type: String,
      trim: true,
      default: "",
    },

    recordingUrl: {
      type: String,
      trim: true,
      default: "",
    },

    transcription: {
      type: String,
      trim: true,
      default: "",
    },

    missedCallTextSent: {
      type: Boolean,
      default: false,
    },

    recovered: {
      type: Boolean,
      default: false,
    },

    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
  },
  {
    timestamps: true,
  },
);

const CallLog =
  mongoose.models.CallLog || mongoose.model("CallLog", CallLogSchema);

export default CallLog;
