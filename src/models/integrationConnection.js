import mongoose from "mongoose";

const { Schema } = mongoose;

const IntegrationConnectionSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
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
      enum: [
        "connected",
        "reconnect_required",
        "disconnected",
        "error",
        "expired",
      ],
      default: "disconnected",
    },

    /* OAuth credentials are encrypted and excluded from normal queries. */
    accessTokenEncrypted: { type: String, select: false, default: "" },
    refreshTokenEncrypted: { type: String, select: false, default: "" },
    tokenExpiresAt: { type: Date, default: null },
    scopes: { type: [String], default: [] },
    grantedScopes: { type: [String], default: [] },

    /* Provider identity and selected resources. */
    providerAccountId: { type: String, trim: true, default: "" },
    providerAccountEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    providerCalendarId: { type: String, trim: true, default: "" },
    providerCalendarName: { type: String, trim: true, default: "" },
    availabilityCalendarIds: { type: [String], default: [] },
    apiVersion: { type: String, trim: true, default: "" },
    metadata: { type: Schema.Types.Mixed, default: {} },

    /* One-time OAuth request state. */
    oauthStateHash: { type: String, select: false, default: "" },
    oauthStateExpiresAt: { type: Date, select: false, default: null },
    oauthCodeVerifierEncrypted: { type: String, select: false, default: "" },

    /* Connection lifecycle and operational health. */
    connectedAt: { type: Date, default: null },
    lastVerifiedAt: { type: Date, default: null },
    disconnectedAt: { type: Date, default: null },
    lastSuccessfulSyncAt: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
    lastErrorCode: { type: String, trim: true, default: "", maxlength: 200 },
    lastErrorMessage: {
      type: String,
      trim: true,
      default: "",
      maxlength: 2000,
    },

    /* Mirrored watch metadata supports indexed maintenance and diagnostics. */
    watchChannelId: { type: String, trim: true, default: "" },
    watchResourceId: { type: String, trim: true, default: "" },
    watchExpiresAt: { type: Date, default: null },
    syncToken: { type: String, select: false, default: "" },
  },
  { timestamps: true },
);

IntegrationConnectionSchema.index(
  { business: 1, provider: 1 },
  { unique: true },
);
IntegrationConnectionSchema.index({ provider: 1, status: 1, updatedAt: -1 });
IntegrationConnectionSchema.index({
  provider: 1,
  watchExpiresAt: 1,
  status: 1,
});

const IntegrationConnection =
  mongoose.models.IntegrationConnection ||
  mongoose.model("IntegrationConnection", IntegrationConnectionSchema);

export default IntegrationConnection;
