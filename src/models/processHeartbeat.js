import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  _id: String, role: { type: String, required: true }, seenAt: { type: Date, required: true },
  release: String, ready: Boolean,
}, { versionKey: false });
schema.index({ seenAt: 1 }, { expireAfterSeconds: 300 });
schema.index({ role: 1, seenAt: 1 });
export default mongoose.models.ProcessHeartbeat || mongoose.model('ProcessHeartbeat', schema);
