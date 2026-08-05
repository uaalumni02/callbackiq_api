import mongoose from "mongoose";

const { Schema } = mongoose;

const SmsContactDisclosureSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    phone: { type: String, required: true, trim: true, maxlength: 32 },
    state: {
      type: String,
      enum: ["pending", "disclosed"],
      default: "pending",
      index: true,
    },
    ownerToken: { type: String, required: true, trim: true, maxlength: 80 },
    operationKey: { type: String, trim: true, maxlength: 240, default: "" },
    leaseExpiresAt: { type: Date, required: true, index: true },
    disclosedAt: { type: Date, default: null },
    providerMessageId: { type: String, trim: true, default: "" },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true },
);

SmsContactDisclosureSchema.index(
  { business: 1, phone: 1 },
  { unique: true, name: "sms_contact_disclosure_identity" },
);
SmsContactDisclosureSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

const SmsContactDisclosure =
  mongoose.models.SmsContactDisclosure ||
  mongoose.model("SmsContactDisclosure", SmsContactDisclosureSchema);

export default SmsContactDisclosure;
