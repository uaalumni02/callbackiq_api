import mongoose from "mongoose";

const { Schema } = mongoose;

const VoiceSettingsVersionSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    version: { type: Number, min: 1, required: true },
    settings: { type: Schema.Types.Mixed, required: true },
    publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reason: { type: String, trim: true, maxlength: 500, default: "" },
    source: { type: String, trim: true, maxlength: 80, default: "dashboard" },
    rolledBackFromVersion: { type: Number, min: 1, default: null },
    publishedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);

VoiceSettingsVersionSchema.index(
  { business: 1, version: 1 },
  { unique: true },
);
VoiceSettingsVersionSchema.index({ business: 1, publishedAt: -1 });

const VoiceSettingsVersion =
  mongoose.models.VoiceSettingsVersion ||
  mongoose.model("VoiceSettingsVersion", VoiceSettingsVersionSchema);

export default VoiceSettingsVersion;
