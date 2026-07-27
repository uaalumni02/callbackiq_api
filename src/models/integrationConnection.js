import mongoose from "mongoose";

const { Schema } = mongoose;

const IntegrationConnectionSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    provider: {
      type: String,
      enum: [
        "google_calendar",
        "jobber",
        "housecall_pro",
        "servicetitan",
      ],
      required: true,
    },
    status: {
      type: String,
      enum: ["connected", "disconnected", "error", "expired"],
      default: "disconnected",
    },

    accessTokenEncrypted: { type: String, select: false, default: "" },
    refreshTokenEncrypted: { type: String, select: false, default: "" },
    tokenExpiresAt: { type: Date, default: null },
    scopes: { type: [String], default: [] },

    providerAccountId: { type: String, trim: true, default: "" },
    providerCalendarId: { type: String, trim: true, default: "" },
    apiVersion: { type: String, trim: true, default: "" },
    metadata: { type: Schema.Types.Mixed, default: {} },

    oauthStateHash: { type: String, select: false, default: "" },
    oauthStateExpiresAt: { type: Date, select: false, default: null },
    oauthCodeVerifierEncrypted: { type: String, select: false, default: "" },

    lastSuccessfulSyncAt: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
    lastErrorMessage: { type: String, trim: true, default: "", maxlength: 2000 },
  },
  { timestamps: true },
);

IntegrationConnectionSchema.index(
  { business: 1, provider: 1 },
  { unique: true },
);
IntegrationConnectionSchema.index({ provider: 1, status: 1, updatedAt: -1 });

const IntegrationConnection =
  mongoose.models.IntegrationConnection ||
  mongoose.model("IntegrationConnection", IntegrationConnectionSchema);

export default IntegrationConnection;
