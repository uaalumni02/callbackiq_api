import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },

    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
    },

    customerPhone: {
      type: String,
      required: true,
      trim: true,
    },

    customerName: {
      type: String,
      trim: true,
      default: "Customer",
    },

    status: {
      type: String,
      enum: ["open", "closed"],
      default: "open",
    },

    aiEnabled: {
      type: Boolean,
      default: true,
    },

    humanTakeover: {
      type: Boolean,
      default: false,
    },

    lastMessage: {
      type: String,
      trim: true,
      default: "",
    },

    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

export default mongoose.model("Conversation", conversationSchema);