import mongoose from "mongoose";

const archiveSnapshotSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["open", "closed"],
      required: true,
    },

    aiEnabled: {
      type: Boolean,
      required: true,
    },

    humanTakeover: {
      type: Boolean,
      required: true,
    },
  },
  { _id: false },
);

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
      enum: ["open", "closed", "archived"],
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

    archivedAt: {
      type: Date,
      default: null,
    },

    archivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Restoring uses this snapshot so archiving does not permanently change
    // the prior open/closed or AI/manual state.
    archiveSnapshot: {
      type: archiveSnapshotSchema,
      default: null,
    },
  },
  { timestamps: true },
);

conversationSchema.index({
  business: 1,
  status: 1,
  lastMessageAt: -1,
  createdAt: -1,
});

export default mongoose.model("Conversation", conversationSchema);
