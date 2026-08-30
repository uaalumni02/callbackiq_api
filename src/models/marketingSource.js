// CALLBACKIQ_MARKETING_ATTRIBUTION_V1
import mongoose from "mongoose";

const { Schema } = mongoose;

export const MARKETING_SOURCE_CHANNELS = [
  "google_ads",
  "google_lsa",
  "google_business_profile",
  "organic_search",
  "facebook",
  "instagram",
  "yelp",
  "angi",
  "direct_mail",
  "referral",
  "website",
  "other",
];

const MarketingSourceSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    name: {
      type: String,
      trim: true,
      required: true,
      maxlength: 80,
    },
    nameKey: {
      type: String,
      trim: true,
      required: true,
      select: false,
    },
    channel: {
      type: String,
      enum: MARKETING_SOURCE_CHANNELS,
      default: "other",
      required: true,
    },
    campaign: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    monthlySpend: { type: Number, min: 0, default: 0 },
    status: {
      type: String,
      enum: ["active", "paused", "archived"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true },
);

MarketingSourceSchema.pre("validate", function normalizeName() {
  this.name = String(this.name || "").trim();
  this.nameKey = this.name.toLowerCase().replace(/\s+/g, " ");
});

MarketingSourceSchema.index(
  { business: 1, nameKey: 1 },
  { unique: true },
);
MarketingSourceSchema.index({ business: 1, status: 1, createdAt: -1 });

const MarketingSource =
  mongoose.models.MarketingSource ||
  mongoose.model("MarketingSource", MarketingSourceSchema);

export default MarketingSource;
