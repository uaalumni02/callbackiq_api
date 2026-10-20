import mongoose from 'mongoose';
import { OPPORTUNITY_TYPES, STATUSES } from '../services/revenueRescuePolicy.js';
const { Schema } = mongoose;
const schema = new Schema({
  business: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  lead: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
  appointment: { type: Schema.Types.ObjectId, ref: 'Appointment', default: null },
  type: { type: String, enum: OPPORTUNITY_TYPES, required: true },
  status: { type: String, enum: STATUSES, default: 'open', required: true },
  externalKey: { type: String, trim: true, maxlength: 160, default: null },
  sourceSystem: { type: String, maxlength: 60, default: 'manual' },
  customerName: { type: String, maxlength: 180, trim: true, default: '' },
  phone: { type: String, maxlength: 40, trim: true, default: '' },
  title: { type: String, maxlength: 200, required: true },
  details: { type: String, maxlength: 1500, default: '' },
  assignee: { type: String, maxlength: 140, default: '' },
  dueAt: { type: Date, default: null },
  contactPermission: { type: String, enum: ['unknown','transactional_review','marketing_verified','opted_out'], default: 'unknown' },
  estimatedCents: { type: Number, min: 0, default: null },
  bookedCents: { type: Number, min: 0, default: null },
  paymentRecordedCents: { type: Number, min: 0, default: null },
  paymentEvidence: { type: String, maxlength: 400, default: '' },
  paymentEvidenceSource: { type: String, enum: ['none','owner_reported','provider_import'], default: 'none' },
  outcomeAt: { type: Date, default: null },
  revision: { type: Number, default: 0 },
  history: [{
    at: {type:Date, default:Date.now}, action: {type:String, maxlength:60},
    actor: {type:String, maxlength:150}, fromStatus: String, toStatus: String,
    note: {type:String, maxlength:1000}
  }],
  lastActionAt: { type: Date, default: null },
}, {timestamps:true});
schema.index({business:1, status:1, dueAt:1});
schema.index({business:1, createdAt:-1});
schema.index({business:1, type:1, externalKey:1}, {unique:true, partialFilterExpression:{externalKey:{$type:'string'}}});
export default mongoose.models.RevenueRescueOpportunity || mongoose.model('RevenueRescueOpportunity', schema);
