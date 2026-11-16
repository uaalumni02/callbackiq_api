import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  _id: String,
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionVersion: { type: Number, required: true },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  consumedAt: { type: Date, default: null },
  enrollmentSecretEncrypted: { type: String, select: false },
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.models.AdminAuthChallenge || mongoose.model('AdminAuthChallenge', schema);
