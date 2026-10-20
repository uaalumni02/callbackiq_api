import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  business: {type:Schema.Types.ObjectId,ref:'Business',required:true},
  phone: {type:String,required:true,trim:true,maxlength:40},
  purpose: {type:String,enum:['estimate_followup','booking_followup','service_reactivation','invoice_reminder','missed_call_recovery','capacity_offer'],required:true},
  status: {type:String,enum:['verified','revoked'],default:'revoked'},
  basis: {type:String,enum:['express_written','documented_transactional_request'],required:true},
  evidence: {type:String,required:true,maxlength:500},
  consentAt: {type:Date,required:true},
  expiresAt: {type:Date,default:null},
  recordedBy: {type:String,maxlength:60,required:true},
  revokedAt: {type:Date,default:null},
}, {timestamps:true});
schema.index({business:1,phone:1,purpose:1},{unique:true});
export default mongoose.models.RevenueAutomationConsent || mongoose.model('RevenueAutomationConsent',schema);
