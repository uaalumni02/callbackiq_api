import '../helpers/model/tenantContext.js';
import mongoose from "mongoose";

const supportTicketSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      // Setup help belongs to an authenticated user even before a business exists.
      required: function () { return this.source !== "setup"; },
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    source: { type: String, enum: ["account", "setup"], default: "account" },

    setupContext: {
      businessName: { type: String, trim: true, maxlength: 100 },
      forwardingPhone: { type: String, trim: true, maxlength: 20 },
      replyEmail: { type: String, trim: true, maxlength: 254 },
    },

    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 140,
    },

    category: {
      type: String,
      enum: ["billing", "account", "technical", "twilio_sms", "ai", "other"],
      default: "other",
    },

    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },

    status: {
      type: String,
      enum: ["open", "in_progress", "resolved", "closed"],
      default: "open",
    },

    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },

    adminNotes: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: "",
    },

    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    lastAdminUpdateAt: {
      type: Date,
      default: null,
    },

    ticketHistory: [
      {
        note: {
          type: String,
          trim: true,
          maxlength: 5000,
          required: true,
        },

        admin: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },

        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    resolvedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

/*
 * Supports a business owner's ticket list with optional status filtering.
 */
supportTicketSchema.index({
  business: 1,
  status: 1,
  updatedAt: -1,
});

/*
 * Supports retrieving ticket history for an individual user.
 */
supportTicketSchema.index({
  user: 1,
  createdAt: -1,
});

/*
 * Supports the admin support queue by status, priority, and latest update.
 */
supportTicketSchema.index({
  status: 1,
  priority: 1,
  updatedAt: -1,
});

export default mongoose.model("SupportTicket", supportTicketSchema);
