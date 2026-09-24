import mongoose from "mongoose";

const { Schema } = mongoose;

const normalizeKeywordList = (values = []) =>
  [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean),
  )].slice(0, 50);

const ServiceOfferingSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    nameKey: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      select: false,
    },
    category: {
      type: String,
      trim: true,
      maxlength: 80,
      default: "general",
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
    aiCanDiscuss: {
      type: Boolean,
      default: true,
    },
    aiCanBook: {
      type: Boolean,
      default: false,
    },
    durationMinutes: {
      type: Number,
      min: 15,
      max: 1440,
      default: 90,
    },
    bufferBeforeMinutes: {
      type: Number,
      min: 0,
      max: 480,
      default: 0,
    },
    bufferAfterMinutes: {
      type: Number,
      min: 0,
      max: 480,
      default: 0,
    },
    estimatedValue: {
      type: Number,
      min: 0,
      default: null,
    },
    priceEstimateMin: {
      type: Number,
      min: 0,
      default: null,
    },
    priceEstimateMax: {
      type: Number,
      min: 0,
      default: null,
    },
    disclosePriceEstimate: {
      type: Boolean,
      default: false,
    },
    priceEstimateDisclaimer: {
      type: String,
      trim: true,
      maxlength: 500,
      default:
        "This is a rough estimate only. Final pricing depends on the actual scope, site conditions, parts, and technician evaluation.",
    },
    diagnosticFee: {
      type: Number,
      min: 0,
      default: null,
    },
    discloseDiagnosticFee: {
      type: Boolean,
      default: false,
    },
    emergencyEligible: {
      type: Boolean,
      default: false,
    },
    diagnosticFallback: { type: Boolean, default: false },
    requiresHumanReview: {
      type: Boolean,
      default: false,
    },
    minimumNoticeMinutesOverride: {
      type: Number,
      min: 0,
      max: 43200,
      default: null,
    },
    allowSameDayBookingOverride: {
      type: Boolean,
      default: null,
    },
    intakePolicy: {
      requireClarification: { type: Boolean, default: false },
      clarificationQuestion: { type: String, trim: true, maxlength: 240, default: '' },
      detailKeywords: { type: [String], default: [] },
    },
    keywords: {
      type: [String],
      default: [],
    },
    excludedKeywords: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

ServiceOfferingSchema.pre("validate", function normalizeService() {
  this.name = String(this.name || "").trim();
  this.nameKey = this.name.toLowerCase().replace(/\s+/g, " ");
  this.category = String(this.category || "general").trim().toLowerCase();
  this.keywords = normalizeKeywordList(this.keywords);
  this.excludedKeywords = normalizeKeywordList(this.excludedKeywords);

  if (
    this.priceEstimateMin != null &&
    this.priceEstimateMax != null &&
    Number(this.priceEstimateMax) < Number(this.priceEstimateMin)
  ) {
    this.invalidate(
      "priceEstimateMax",
      "priceEstimateMax must be greater than or equal to priceEstimateMin",
    );
  }
});

ServiceOfferingSchema.index(
  { business: 1, nameKey: 1 },
  { unique: true },
);
ServiceOfferingSchema.index({ business: 1, active: 1, category: 1 });

const ServiceOffering =
  mongoose.models.ServiceOffering ||
  mongoose.model("ServiceOffering", ServiceOfferingSchema);

export default ServiceOffering;
