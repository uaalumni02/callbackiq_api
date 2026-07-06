import mongoose from "mongoose";

const demoRequestSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    phone: {
      type: String,
      trim: true,
      default: "",
    },

    businessName: {
      type: String,
      required: true,
      trim: true,
    },

    businessType: {
      type: String,
      trim: true,
      default: "",
    },

    website: {
      type: String,
      trim: true,
      default: "",
    },

    message: {
      type: String,
      trim: true,
      default: "",
    },

    preferredTime: {
      type: String,
      trim: true,
      default: "",
    },

    status: {
      type: String,
      enum: ["new", "contacted", "scheduled", "closed", "spam"],
      default: "new",
    },

    source: {
      type: String,
      default: "website",
      trim: true,
    },

    adminNotes: {
      type: String,
      trim: true,
      default: "",
    },

    contactedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("DemoRequest", demoRequestSchema);
