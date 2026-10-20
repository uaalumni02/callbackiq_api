import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  business: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  opportunity: { type: Schema.Types.ObjectId, ref: 'RevenueRescueOpportunity', default: null },
  recordType: { type: String, enum: ['estimate','job','invoice'], required: true },
  reference: { type: String, trim: true, maxlength: 90, required: true },
  title: { type: String, trim: true, maxlength: 200, required: true },
  customerName: { type: String, trim: true, maxlength: 180, default: '' },
  customerPhone: { type: String, trim: true, maxlength: 40, default: '' },
  description: { type: String, trim: true, maxlength: 1500, default: '' },
  status: { type: String, enum: ['draft','sent','awaiting_customer','accepted','declined','scheduled','in_progress','completed','issued','partially_paid','paid','canceled','void'], required: true },
  amountCents: { type: Number, min: 0, default: 0, required: true },
  paidCents: { type: Number, min: 0, default: 0, required: true },
  dueAt: { type: Date, default: null },
  paymentUrl: { type: String, maxlength: 1000, default: '' },
  paymentEvidenceRef: { type: String, maxlength: 300, default: '' },
  evidenceSource: { type: String, enum: ['owner_reported','provider_verified'], default: 'owner_reported' },
  revision: { type: Number, default: 0 },
  history: [{at: {type:Date,default:Date.now},actor:String,action:String,note:{type:String,maxlength:500}}],
}, { timestamps:true });
schema.index({business:1, recordType:1, reference:1}, {unique:true});
schema.index({business:1,status:1,updatedAt:-1});
export default mongoose.models.InternalRevenueRecord || mongoose.model('InternalRevenueRecord',schema);
