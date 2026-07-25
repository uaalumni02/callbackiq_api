import mongoose from "mongoose";

const { Schema } = mongoose;

const ContactPreferenceSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },

    phone: {
      type: String,
      required: true,
      trim: true,
    },

    smsStatus: {
      type: String,
      enum: ["active", "opted_out"],
      default: "active",
      required: true,
    },

    optedOutAt: {
      type: Date,
      default: null,
    },

    optedInAt: {
      type: Date,
      default: null,
    },

    source: {
      type: String,
      enum: ["twilio_keyword", "customer_request", "staff", "system"],
      default: "system",
    },

    lastKeyword: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: true,
  },
);

ContactPreferenceSchema.index(
  {
    business: 1,
    phone: 1,
  },
  {
    unique: true,
  },
);

const ContactPreference =
  mongoose.models.ContactPreference ||
  mongoose.model("ContactPreference", ContactPreferenceSchema);

export default ContactPreference;
