import '../helpers/model/tenantContext.js';
import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  _id: String,
  business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', required: true },
  kind: { type: String, required: true },
  field: { type: String, required: true },
  status: { type: String, enum: ['queued', 'sending', 'sent', 'uncertain', 'failed'], default: 'queued' },
  claimToken: String,
  leaseUntil: Date,
  availableAt: { type: Date, default: Date.now },
  attempts: { type: Number, default: 0 },
  sentAt: Date,
  subscriptionRecorded: { type: Boolean, default: false },
  providerMessageId: String,
  lastErrorCode: String,
  reviewRecorded: { type: Boolean, default: false },
}, { timestamps: true });
schema.index({ status: 1, availableAt: 1, _id: 1 });
schema.index({ status: 1, leaseUntil: 1, reviewRecorded: 1 });
export default mongoose.models.TrialLifecycleDelivery || mongoose.model('TrialLifecycleDelivery', schema);
