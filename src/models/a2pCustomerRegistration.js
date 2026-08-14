import mongoose from "mongoose";

const { Schema } = mongoose;

const A2pCustomerRegistrationSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: [
        "not_started",
        "submitted",
        "brand_pending",
        "otp_required",
        "brand_approved",
        "campaign_pending",
        "number_pending",
        "ready",
        "action_required",
        "failed",
      ],
      default: "not_started",
      index: true,
    },
    registrationType: {
      type: String,
      enum: ["standard", "low_volume_standard", "sole_proprietor"],
      default: "low_volume_standard",
    },
    legalBusinessName: { type: String, trim: true, default: "" },
    businessType: { type: String, trim: true, default: "" },
    businessIndustry: { type: String, trim: true, default: "CONSTRUCTION" },
    websiteUrl: { type: String, trim: true, default: "" },
    registrationNumberLast4: { type: String, trim: true, default: "" },
    mobilePhoneLast4: { type: String, trim: true, default: "" },
    contactEmail: { type: String, trim: true, lowercase: true, default: "" },
    campaign: {
      description: { type: String, trim: true, default: "" },
      messageFlow: { type: String, trim: true, default: "" },
      messageSamples: { type: [String], default: [] },
      useCase: { type: String, trim: true, default: "CUSTOMER_CARE" },
      hasEmbeddedLinks: { type: Boolean, default: false },
      hasEmbeddedPhone: { type: Boolean, default: false },
      privacyPolicyUrl: { type: String, trim: true, default: "" },
      termsAndConditionsUrl: { type: String, trim: true, default: "" },
    },

    // Backend-only Twilio identifiers. Never serialize these to the customer UI.
    customerProfileSid: { type: String, trim: true, default: "", select: false },
    businessEndUserSid: { type: String, trim: true, default: "", select: false },
    authorizedRepresentativeSid: { type: String, trim: true, default: "", select: false },
    addressSid: { type: String, trim: true, default: "", select: false },
    addressDocumentSid: { type: String, trim: true, default: "", select: false },
    trustProductSid: { type: String, trim: true, default: "", select: false },
    messagingProfileEndUserSid: { type: String, trim: true, default: "", select: false },
    brandSid: { type: String, trim: true, default: "", select: false },
    messagingServiceSid: { type: String, trim: true, default: "", select: false },
    campaignSid: { type: String, trim: true, default: "", select: false },

    customerProfileStatus: { type: String, trim: true, default: "" },
    trustProductStatus: { type: String, trim: true, default: "" },
    brandStatus: { type: String, trim: true, default: "" },
    brandIdentityStatus: { type: String, trim: true, default: "" },
    campaignStatus: { type: String, trim: true, default: "" },
    numberStatus: { type: String, trim: true, default: "" },
    otpStatus: { type: String, trim: true, default: "" },
    otpRequestedAt: { type: Date, default: null },
    otpRetryWindowStartedAt: { type: Date, default: null },
    otpRetryCount: { type: Number, min: 0, default: 0 },
    lastNumberEventId: { type: String, trim: true, default: "" },
    lastNumberEventAt: { type: Date, default: null },
    lastNumberEventRank: { type: Number, min: 0, default: 0 },
    submittedAt: { type: Date, default: null },
    brandApprovedAt: { type: Date, default: null },
    campaignCreatedAt: { type: Date, default: null },
    numberAttachedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    lastSyncedAt: { type: Date, default: null },
    lastError: { type: String, trim: true, maxlength: 2000, default: "" },
  },
  { timestamps: true },
);

A2pCustomerRegistrationSchema.index({ brandSid: 1 }, { sparse: true });
A2pCustomerRegistrationSchema.index({ campaignSid: 1 }, { sparse: true });
A2pCustomerRegistrationSchema.index({ messagingServiceSid: 1 }, { sparse: true });

export default mongoose.model("A2pCustomerRegistration", A2pCustomerRegistrationSchema);
