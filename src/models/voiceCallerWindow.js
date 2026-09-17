import mongoose from "mongoose";

// One atomic rolling window per tenant and caller. _id is the unique admission
// boundary, so correctness does not depend on an asynchronously built index.
const schema = new mongoose.Schema({
  _id: String,
  attempts: { type: [{ key: String, at: Date, allowed: Boolean, _id: false }], default: [] },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.models.VoiceCallerWindow || mongoose.model("VoiceCallerWindow", schema);
