import mongoose from 'mongoose';
const { Schema } = mongoose;
const RecoveryCaseSchema = new Schema({
  business: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
  lead: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
  generation: { type: Number, min: 1, default: 1 },
  version: { type: Number, min: 0, default: 0 },
  status: { type: String, enum: ['qualifying','needs_review','accepted','declined','scheduling','booked','closed'], default: 'needs_review' },
  facts: { customerName: String, serviceNeeded: String, address: String, preferredAppointmentTime: String },
  serviceDecision: {
    decision: { type: String, enum: ['pending','accepted','declined'], default: 'pending' },
    serviceOfferingId: { type: Schema.Types.ObjectId, ref: 'ServiceOffering', default: null },
    requestFingerprint: String, reason: String,
    actor: { type: Schema.Types.ObjectId, ref: 'User' }, decidedAt: Date,
  },
  booking: {
    appointment: { type: Schema.Types.ObjectId, ref: 'Appointment', default: null },
    status: { type: String, enum: ['none','held','confirmed','failed'], default: 'none' },
    lastVerifiedAt: Date,
  },
  source: { leadUpdatedAt: Date, conversationUpdatedAt: Date },
}, { timestamps: true, minimize: false, strict: 'throw' });
RecoveryCaseSchema.index({ business: 1, conversation: 1, generation: 1 }, { unique: true });
RecoveryCaseSchema.index({ business: 1, lead: 1, status: 1, updatedAt: -1 });
RecoveryCaseSchema.index({ status: 1, 'booking.status': 1, updatedAt: 1, _id: 1 });
export default mongoose.models.RecoveryCase || mongoose.model('RecoveryCase', RecoveryCaseSchema);
