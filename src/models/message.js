import mongoose from "mongoose";
const { Schema } = mongoose;

import * as validate from "../helpers/model/message.js";

const MessageSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },

    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },

    lead: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },

    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      required: true,
      validate: [validate.isValidDirection, "Invalid message direction"],
    },

    from: {
      type: String,
      required: true,
      trim: true,
    },

    to: {
      type: String,
      required: true,
      trim: true,
    },

    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1600,
    },

    provider: {
      type: String,
      enum: ["manual", "twilio", "system"],
      default: "manual",
    },

    /*
     * Twilio Message SID for inbound and outbound messages.
     *
     * The existing providerMessageId name is retained to avoid an unnecessary
     * data migration. Manual and system messages continue using an empty
     * string and are excluded from the unique provider index below.
     */
    providerMessageId: {
      type: String,
      default: "",
      trim: true,
    },

    status: {
      type: String,
      enum: ["queued", "sent", "delivered", "failed", "received"],
      default: "sent",
    },
    isAiGenerated: { type: Boolean, default: false },
    generatedBy: {
      type: String,
      enum: ["ai", "guardrail", "user", "automation", "voice", "system", ""],
      default: "",
    },
    usageCategory: { type: String, trim: true, maxlength: 80, default: "" },
    actorType: {
      type: String,
      enum: ["user", "ai", "automation", "voice", "webhook", "system", ""],
      default: "",
    },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
  },
);

/*
 * Supports loading a complete transcript in chronological order.
 */
MessageSchema.index({
  conversation: 1,
  createdAt: 1,
});

/*
 * Supports recent message queries and business dashboard calculations.
 */
MessageSchema.index({
  business: 1,
  createdAt: -1,
});
MessageSchema.index({
  business: 1,
  isAiGenerated: 1,
  createdAt: -1,
});

/*
 * Prevents the same Twilio Message SID from being stored twice for one
 * business while excluding manual and system messages that have no SID.
 *
 * Run the Phase 0 duplicate audit before deploying this unique index against
 * an existing production database.
 */
MessageSchema.index(
  {
    business: 1,
    providerMessageId: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      providerMessageId: {
        $gt: "",
      },
    },
  },
);

const Message =
  mongoose.models.Message || mongoose.model("Message", MessageSchema);

export default Message;
