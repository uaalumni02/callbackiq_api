import mongoose from 'mongoose';
const { Schema } = mongoose;
const RecoveryEventSchema = new Schema({
  business: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  recoveryCase: { type: Schema.Types.ObjectId, ref: 'RecoveryCase', required: true },
  conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
  operationId: { type: String, required: true, maxlength: 128 },
  operationHash: { type: String, required: true },
  kind: { type: String, enum: ['facts_corrected','service_accepted','service_declined','booking_observed'], required: true },
  versionBefore: { type: Number, required: true },
  versionAfter: { type: Number, required: true },
  actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  evidence: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true, strict: 'throw' });
RecoveryEventSchema.index({ business: 1, operationId: 1 }, { unique: true });
RecoveryEventSchema.index({ business: 1, recoveryCase: 1, createdAt: -1, _id: -1 });
export default mongoose.models.RecoveryEvent || mongoose.model('RecoveryEvent', RecoveryEventSchema);
