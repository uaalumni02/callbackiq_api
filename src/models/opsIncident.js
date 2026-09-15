import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  _id: String,
  alert: { type: mongoose.Schema.Types.ObjectId, ref: 'Alert' },
  business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business' },
  desiredAction: { type: String, enum: ['trigger', 'resolve'], default: 'trigger' },
  status: { type: String, enum: ['pending', 'sending', 'accepted', 'failed'], default: 'pending' },
  revision: { type: Number, default: 0 }, attempts: { type: Number, default: 0 },
  checkedAt: { type: Date, default: () => new Date(0) },
  nextAttemptAt: { type: Date, default: Date.now }, leaseUntil: Date, leaseToken: String,
  reason: String, lastErrorCode: String,
  published: { type: Boolean, default: false },
}, { timestamps: true });
schema.index({ status: 1, nextAttemptAt: 1 });
schema.index({ status: 1, leaseUntil: 1 });
schema.index({ desiredAction: 1, checkedAt: 1 });
schema.index({ published: 1, updatedAt: 1 });
export default mongoose.models.OpsIncident || mongoose.model('OpsIncident', schema);
