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

/*
 * Supports Twilio Message SID lookups without indexing the empty-string
 * value used by manual and system records.
 *
 * This is non-unique to avoid causing deployment failures if retry data
 * already contains duplicate provider IDs.
 */
MessageSchema.index(
  {
    providerMessageId: 1,
  },
  {
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
