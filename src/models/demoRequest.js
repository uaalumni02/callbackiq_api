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

/*
 * Supports the default admin list sorted newest first.
 */
demoRequestSchema.index({
  createdAt: -1,
});

/*
 * Supports admin status filters while retaining newest-first sorting.
 */
demoRequestSchema.index({
  status: 1,
  createdAt: -1,
});

/*
 * Supports finding previous requests submitted by an email address.
 */
demoRequestSchema.index({
  email: 1,
  createdAt: -1,
});

export default mongoose.model("DemoRequest", demoRequestSchema);
