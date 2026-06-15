import mongoose from "mongoose";
const { Schema } = mongoose;

import * as validate from "../helpers/model/business.js";

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

    phone: {
      type: String,
      required: [true, "Business phone is required"],
      trim: true,
      validate: [validate.isValidPhone, "Please enter a valid phone number"],
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

    estimatedJobValue: {
      type: Number,
      default: 500,
      min: 0,
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

const Business =
  mongoose.models.Business || mongoose.model("Business", BusinessSchema);

export default Business;
