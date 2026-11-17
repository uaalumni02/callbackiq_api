import '../helpers/model/tenantContext.js';
import mongoose from 'mongoose';

const { Schema } = mongoose;
const observedSubscription = new Schema({
  subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', required: true },
  status: { type: String, required: true, maxlength: 40 },
  stripeSubscriptionId: { type: String, default: '', select: false },
  trialEndsAt: { type: Date, default: null },
  trialNumberReleaseAt: { type: Date, default: null },
}, { _id: false });

const releaseIntentSchema = new Schema({
  // Deterministic digest of business, observed SID, revision and authorization.
  _id: { type: String, required: true, maxlength: 64 },
  schemaVersion: { type: Number, required: true, enum: [1] },
  business: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  provider: { type: String, required: true, enum: ['twilio'] },
  providerAccountSid: { type: String, required: true, select: false },
  providerSid: { type: String, required: true, select: false },
  resourceRole: { type: String, required: true, enum: ['assigned', 'unattached'], default: 'assigned' },
  claimRevision: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  observedRevision: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  authorization: {
    kind: { type: String, required: true, enum: ['trial_expiry', 'business_deletion', 'administrative', 'orphan_cleanup'] },
    subscription: { type: observedSubscription, default: null },
    deletionStartedAt: { type: Date, default: null },
  },
  status: { type: String, required: true,
    enum: ['pending', 'dispatching', 'uncertain', 'completed', 'superseded'] },
  claimGeneration: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  claimToken: { type: String, default: '', select: false },
  claimExpiresAt: { type: Date, default: null },
  dispatchedAt: { type: Date, default: null },
  reconciledAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  providerOutcome: { type: String, default: 'unknown',
    enum: ['unknown', 'removed', 'absent', 'present', 'rejected'] },
  lastErrorCode: { type: String, default: '', maxlength: 100 },
}, { timestamps: true, collection: 'trackingnumberreleaseintents' });

// New collection only. Never TTL-delete unresolved external outcomes.
releaseIntentSchema.index({ status: 1, claimExpiresAt: 1 });
releaseIntentSchema.index({ business: 1, createdAt: -1 });
releaseIntentSchema.index({ providerAccountSid: 1, providerSid: 1 }, { unique: true, name: 'one_unresolved_resource_release',
  partialFilterExpression: { status: { $in: ['pending', 'dispatching', 'uncertain'] } } });

export default mongoose.models.TrackingNumberReleaseIntent ||
  mongoose.model('TrackingNumberReleaseIntent', releaseIntentSchema);
